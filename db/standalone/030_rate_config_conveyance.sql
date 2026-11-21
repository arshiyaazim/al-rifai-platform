-- 030: Owner-approved destination conveyance rates (2026-11-21).
--
-- Rate values are stored in minor units (paisa). Shift rate stays BDT 200 per
-- shift (20000 minor) for the standard escort rate; security's 12-hour minimum
-- is applied by the payroll service, not by mutating historical program_pay.
-- This migration is data-only and idempotent.

INSERT INTO rate_config (destination_key, destination_label, shift_rate_minor, conveyance_minor, effective_from, active)
VALUES
  ('nowapara',    'Nowapara',    20000, 120000, DATE '2025-01-01', true),
  ('nagorbari',   'Nagor Bari',  20000, 110000, DATE '2025-01-01', true),
  ('baghabari',   'Bagha Bari',  20000, 110000, DATE '2025-01-01', true),
  ('jhalokathi',  'Jhalokathi',  20000, 110000, DATE '2025-01-01', true),
  ('barishal',    'Barishal',    20000, 100000, DATE '2025-01-01', true),
  ('vhola',       'Vhola',       20000, 100000, DATE '2025-01-01', true),
  ('local',       'Local',       20000,      0, DATE '2025-01-01', true),
  ('chattogram',  'Chattogram',  20000,      0, DATE '2025-01-01', true),
  ('faridpur',    'Faridpur',    20000, 100000, DATE '2025-01-01', true)
ON CONFLICT (destination_key) DO UPDATE
  SET destination_label = EXCLUDED.destination_label,
      shift_rate_minor = EXCLUDED.shift_rate_minor,
      conveyance_minor = EXCLUDED.conveyance_minor,
      effective_from = EXCLUDED.effective_from,
      active = true,
      updated_at = now();
