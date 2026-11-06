import {rows} from '../standalone/db.ts';

export async function programsLookup(input: {query?: string; employeeMobile?: string | null}) {
  const q = String(input.query ?? '').trim().toLowerCase();
  return rows(
    `SELECT p.id, p.mother_vessel, p.lighter_vessel, p.master_mobile, p.destination,
            p.escort_name, p.escort_mobile, p.start_date::text AS start_date, p.start_shift,
            p.end_date::text AS end_date, p.end_shift, p.state, p.confirmation_message_id,
            pp.state AS pay_state, pp.total_minor::text
       FROM programs p LEFT JOIN program_pay pp ON pp.program_id = p.id
      WHERE ($2::text IS NULL OR p.escort_mobile = $2)
        AND ($1 = '' OR lower(p.mother_vessel) LIKE '%' || $1 || '%'
             OR lower(p.lighter_vessel) LIKE '%' || $1 || '%'
             OR lower(coalesce(p.escort_name,'')) LIKE '%' || $1 || '%')
      ORDER BY p.start_date DESC LIMIT 30`,
    [q, input.employeeMobile ?? null],
  );
}
