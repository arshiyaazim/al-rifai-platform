import {actorFor, errorResponse, ok} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {rows} from '@/lib/standalone/db';
import {transliterate} from '@/lib/standalone/transliterate';
import {generateNameVariants} from '@/lib/standalone/ai-assistant-names';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchRow = {
  employee_mobile: string;
  preferred_name: string;
  designation: string | null;
  similarity_score: number | string;
  match_type: string;
};

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'employee.read');

    const url = new URL(request.url);
    const raw = (url.searchParams.get('q') ?? '').trim();
    if (raw.length < 2) return ok([]);
    const query = transliterate(raw).trim().slice(0, 80);
    if (!query) return ok([]);
    const digits = query.replace(/\D/g, '');
    // A mobile is identified by its last 11 digits; shorter input is too noisy.
    const mobileKey = digits.length >= 4 ? digits.slice(-11) : null;

    const searchOne = (term: string) => rows<SearchRow>(
      `WITH p AS (SELECT $1::text AS q, $2::text AS digits),
            scored AS (
              SELECT e.employee_mobile,
                     e.preferred_name,
                     e.designation,
                     right(regexp_replace(e.employee_mobile, '\\D', '', 'g'), 11) AS mobile11,
                     EXISTS (
                       SELECT 1 FROM unnest(e.name_aliases) AS alias WHERE lower(alias) = lower(p.q)
                     ) AS alias_exact,
                     greatest(
                       similarity(e.preferred_name, p.q),
                       (SELECT max(similarity(word, p.q))
                          FROM unnest(regexp_split_to_array(e.preferred_name, '\\s+')) AS word),
                       CASE WHEN p.digits IS NOT NULL
                            THEN similarity(right(regexp_replace(e.employee_mobile, '\\D', '', 'g'), 11), p.digits)
                            ELSE 0 END
                     )::numeric(4,3) AS raw_score
                FROM employees e, p
               WHERE e.state = 'ACTIVE'
                 AND (
                   (p.digits IS NOT NULL AND length(p.digits) >= 4
                    AND right(regexp_replace(e.employee_mobile, '\\D', '', 'g'), 11) LIKE '%' || p.digits || '%')
                   OR e.preferred_name ILIKE '%' || p.q || '%'
                   OR e.preferred_name % p.q
                   OR EXISTS (
                     SELECT 1 FROM unnest(regexp_split_to_array(e.preferred_name, '\\s+')) AS word
                      WHERE word % p.q
                   )
                   OR EXISTS (SELECT 1 FROM unnest(e.name_aliases) AS alias WHERE alias ILIKE '%' || p.q || '%')
                   OR (p.digits IS NOT NULL AND p.q ~ '^[0-9+ -]+$'
                       AND right(regexp_replace(e.employee_mobile, '\\D', '', 'g'), 11) % p.digits)
                 )
            )
       SELECT employee_mobile, preferred_name, designation,
              CASE
                WHEN p.digits IS NOT NULL AND mobile11 = p.digits THEN 1.0
                WHEN lower(preferred_name) = lower(p.q) THEN 0.95
                WHEN alias_exact THEN 0.95
                ELSE round(raw_score, 3)
              END AS similarity_score,
              CASE
                WHEN p.digits IS NOT NULL AND mobile11 = p.digits THEN 'mobile_exact'
                WHEN lower(preferred_name) = lower(p.q) THEN 'name_exact'
                WHEN alias_exact THEN 'alias_exact'
                WHEN p.digits IS NOT NULL AND length(p.digits) >= 10 AND raw_score >= 0.6 THEN 'mobile_fuzzy'
                WHEN raw_score >= 0.6 THEN 'fuzzy'
                WHEN preferred_name ILIKE '%' || p.q || '%' THEN 'partial'
                WHEN p.digits IS NOT NULL AND mobile11 LIKE '%' || p.digits || '%' THEN 'mobile_partial'
                WHEN raw_score >= 0.3 THEN 'fuzzy'
                ELSE 'partial'
              END AS match_type
         FROM scored, p
        ORDER BY similarity_score DESC, preferred_name
        LIMIT 20`,
      [term, mobileKey],
    );

    // expand=1 unions every plausible spelling variant and dedupes by mobile.
    const expand = url.searchParams.get('expand') === '1'
      && /[a-zA-Z\u0980-\u09FF]/.test(raw);
    const terms = expand ? generateNameVariants(raw).all.slice(0, 12) : [query];
    const lists = await Promise.all(terms.map((term) => searchOne(term)));
    const merged = new Map<string, SearchRow>();
    for (const entry of lists.flat()) {
      const score = Number(entry.similarity_score);
      const current = merged.get(entry.employee_mobile);
      if (!current || score > Number(current.similarity_score)) merged.set(entry.employee_mobile, entry);
    }
    const result = [...merged.values()]
      .sort((a, b) => Number(b.similarity_score) - Number(a.similarity_score)
        || a.preferred_name.localeCompare(b.preferred_name))
      .slice(0, 20);

    return ok(result.map((entry) => ({...entry, similarity_score: Number(entry.similarity_score)})));
  } catch (error) {
    return errorResponse(error);
  }
}
