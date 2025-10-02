-- Ensure pgcrypto for UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Clientes table shared across tenant databases
CREATE TABLE IF NOT EXISTS clientes (
    id              BIGSERIAL PRIMARY KEY,
    uuid            UUID NOT NULL DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    nome            TEXT,
    nome_recebido   TEXT,
    whatsapp        TEXT,
    paused          BOOLEAN NOT NULL DEFAULT FALSE,
    ultimo_acesso   TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT clientes_whatsapp_unique UNIQUE (whatsapp)
);

-- Keep updated_at in sync
CREATE OR REPLACE FUNCTION set_clientes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_clientes_updated_at ON clientes;
CREATE TRIGGER trg_clientes_updated_at
BEFORE UPDATE ON clientes
FOR EACH ROW
EXECUTE FUNCTION set_clientes_updated_at();

-- graficos_dashboard metadata table used by dashboard visualizations
CREATE TABLE IF NOT EXISTS graficos_dashboard (
    id              BIGSERIAL PRIMARY KEY,
    slug            TEXT UNIQUE NOT NULL,
    title           TEXT,
    description     TEXT,
    query_template  TEXT NOT NULL,
    param_schema    JSONB,
    default_params  JSONB,
    result_shape    JSONB,
    allowed_roles   TEXT[] DEFAULT ARRAY['user'],
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION set_graficos_dashboard_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_graficos_dashboard_updated_at ON graficos_dashboard;
CREATE TRIGGER trg_graficos_dashboard_updated_at
BEFORE UPDATE ON graficos_dashboard
FOR EACH ROW
EXECUTE FUNCTION set_graficos_dashboard_updated_at();
