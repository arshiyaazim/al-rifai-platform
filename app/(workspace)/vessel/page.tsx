import {countPrograms, listPrograms} from '@/lib/standalone/programs';
import {listEmployees} from '@/lib/standalone/employees';
import {rows} from '@/lib/standalone/db';
import {pageUser} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {ActionForm} from '@/components/standalone/action-form';
import {VesselRegisterClient} from '@/components/standalone/vessel-register-client';

export const dynamic = 'force-dynamic';

const VESSEL_CLIENTS = [
  {jid: '8801670535255@s.whatsapp.net', label: 'Hridoy PN'},
  {jid: '166082241384593@lid', label: 'Hridoy LID'},
  {jid: '8801836743754@s.whatsapp.net', label: 'Rezaul'},
  {jid: '8801757622300@s.whatsapp.net', label: 'TCIS'},
];

export default async function VesselPage({searchParams}: {searchParams: Promise<{q?: string; state?: string; page?: string; mother?: string; escort_mobile?: string}>}) {
  const filters = await searchParams;
  const user = await pageUser();
  const canCommand = can(user as never, 'vessel.command');
  const canRelease = can(user as never, 'vessel.release');
  const q = (filters.q ?? '').trim();
  const state = filters.state ?? '';
  const mother = filters.mother ?? '';
  const escortMobile = (filters.escort_mobile ?? '').trim();
  const [initialPrograms, tableTotal, escorts, motherRows, lighterRows, escortNameRows, escortMobileRows] = await Promise.all([
    listPrograms({q, state: state || undefined, mother: mother || undefined, escortMobile: escortMobile || undefined, limit: 20, offset: 0}),
    countPrograms({q, state: state || undefined, mother: mother || undefined, escortMobile: escortMobile || undefined}),
    listEmployees({state: 'ACTIVE', limit: 500}),
    rows<{vessel_name: string}>("SELECT vessel_name FROM vessels WHERE vessel_type = 'mother' ORDER BY vessel_name"),
    rows<{vessel_name: string}>("SELECT vessel_name FROM vessels WHERE vessel_type = 'lighter' ORDER BY vessel_name"),
    rows<{escort_name: string}>('SELECT DISTINCT escort_name FROM programs WHERE escort_name IS NOT NULL ORDER BY escort_name'),
    rows<{escort_mobile: string}>('SELECT DISTINCT escort_mobile FROM programs WHERE escort_mobile IS NOT NULL ORDER BY escort_mobile'),
  ]);

  return (
    <div className="vessel-workspace">
      <div className="page-head">
        <div><h1>Vessel Register</h1><p className="muted">Orders, escorts, duty dates and release.</p></div>
      </div>

      <VesselRegisterClient
        initial={{
          rows: initialPrograms,
          total: tableTotal,
          page: 1,
          limit: 20,
          totalPages: Math.max(1, Math.ceil(tableTotal / 20)),
        }}
        escorts={escorts.map((employee) => ({mobile: employee.employee_mobile, name: employee.preferred_name}))}
        mothers={motherRows.map((row) => row.vessel_name)}
        lighters={lighterRows.map((row) => row.vessel_name)}
        escortNames={escortNameRows.map((row) => row.escort_name)}
        escortMobiles={escortMobileRows.map((row) => row.escort_mobile)}
        clients={VESSEL_CLIENTS}
        initialQ={q}
        initialState={state}
        initialMother={mother}
        initialEscortMobile={escortMobile}
        canCommand={canCommand}
        canRelease={canRelease}
      />

      <div className="split">
        {canCommand ? (
          <ActionForm title="Assign / replace escort" endpoint="/api/programs" action="assign" submitLabel="Assign"
            fields={[
              {name: 'programId', label: 'Program id', required: true},
              {name: 'employeeMobile', label: 'Escort mobile', required: true},
              {name: 'employeeName', label: 'Escort name'},
              {name: 'startDate', label: 'Start date', type: 'date'},
              {name: 'startShift', label: 'Shift', type: 'select', options: [{value: 'D', label: 'Day'}, {value: 'N', label: 'Night'}]},
            ]} />
        ) : null}
        {canRelease ? (
          <ActionForm title="Release" endpoint="/api/programs" action="release" submitLabel="Release"
            fields={[
              {name: 'programId', label: 'Program id', required: true},
              {name: 'endDate', label: 'End date', type: 'date', required: true},
              {name: 'endShift', label: 'End shift', type: 'select', options: [{value: 'D', label: 'Day'}, {value: 'N', label: 'Night'}]},
              {name: 'note', label: 'Note'},
            ]} />
        ) : null}
        {canCommand ? (
          <ActionForm title="Void" endpoint="/api/programs" action="void" submitLabel="Void program"
            fields={[
              {name: 'programId', label: 'Program id', required: true},
              {name: 'reason', label: 'Reason', required: true},
            ]} />
        ) : null}
      </div>
    </div>
  );
}
