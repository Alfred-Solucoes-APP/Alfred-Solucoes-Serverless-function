-- Create table to store dashboard table metadata per tenant database
CREATE TABLE IF NOT EXISTS dashboard_tables (
    id            BIGSERIAL PRIMARY KEY,
    slug          TEXT UNIQUE NOT NULL,
    title         TEXT,
    description   TEXT,
    query_template TEXT NOT NULL,
    column_config  JSONB NOT NULL DEFAULT '[]'::jsonb,
    param_schema   JSONB,5
    default_params JSONB,
    result_shape   JSONB,
    allowed_roles  TEXT[] DEFAULT ARRAY['user'],
    primary_key    TEXT,
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Optional helper trigger to keep updated_at fresh
CREATE OR REPLACE FUNCTION set_dashboard_tables_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dashboard_tables_updated_at ON dashboard_tables;
CREATE TRIGGER trg_dashboard_tables_updated_at
BEFORE UPDATE ON dashboard_tables
FOR EACH ROW
EXECUTE FUNCTION set_dashboard_tables_updated_at();

-- Example insert for reference (remove or adapt per tenant)
-- INSERT INTO dashboard_tables (slug, title, description, query_template, column_config)
-- VALUES (
--   'reservas_pendentes',
--   'Reservas Pendentes',
--   'Lista de reservas ainda não confirmadas',
--   'SELECT id, cliente, status, criado_em FROM reservas WHERE status = ''pendente'' ORDER BY criado_em DESC',
--   '[{"key": "cliente", "label": "Cliente"}, {"key": "status", "label": "Status"}, {"key": "criado_em", "label": "Criado em", "type": "date"}]'
-- );
