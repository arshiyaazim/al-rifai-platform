-- 028: employee profile extensions (salary override, profile photo, documents).
-- Additive and nullable: NULL salary_amount means "use the derived ৳400/day rate".
-- The repo keeps migrations in db/standalone/, not prisma/migrations.

BEGIN;

-- 1) Salary override. NULL = derive ৳400/day from approved attendance.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS salary_amount INTEGER;

-- 2) Profile photo. Relative path: /uploads/employees/<employee_mobile>/photo-<uuid>.<ext>
ALTER TABLE employees ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- 3) Uploaded documents (NID scans, certificates, contracts).
CREATE TABLE IF NOT EXISTS employee_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_mobile TEXT NOT NULL REFERENCES employees(employee_mobile) ON UPDATE CASCADE,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_type TEXT NOT NULL,
  mime_type TEXT,
  file_size_bytes INTEGER,
  uploaded_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employee_documents_file_type_check CHECK (file_type IN ('image', 'pdf', 'document'))
);

CREATE INDEX IF NOT EXISTS idx_emp_docs_mobile ON employee_documents(employee_mobile);

COMMIT;
