import {actorFor, errorResponse, ok} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {rows} from '@/lib/standalone/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'employee.read');
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') ?? '').trim();
    const field = url.searchParams.get('field') === 'mobile' ? 'mobile' : 'name';
    if (q.length < 2) return ok({rows: []});
    const digits = q.replace(/[^0-9]/g, '');
    const data = field === 'mobile'
      ? await rows<{employee_mobile: string; preferred_name: string; designation: string | null}>(
        `SELECT employee_mobile, preferred_name, designation
           FROM employees
          WHERE state = 'ACTIVE'
            AND ($1 = '' OR regexp_replace(employee_mobile, '\\D', '', 'g') LIKE '%' || $1 || '%')
          ORDER BY preferred_name
          LIMIT 10`, [digits])
      : await rows<{employee_mobile: string; preferred_name: string; designation: string | null}>(
        `SELECT employee_mobile, preferred_name, designation
           FROM employees
          WHERE state = 'ACTIVE'
            AND (preferred_name ILIKE '%' || $1 || '%'
                 OR EXISTS (SELECT 1 FROM unnest(name_aliases) AS alias WHERE alias ILIKE '%' || $1 || '%'))
          ORDER BY preferred_name
          LIMIT 10`, [q]);
    return ok({
      rows: data.map((row) => ({
        mobile: row.employee_mobile,
        name: row.preferred_name,
        designation: row.designation,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
