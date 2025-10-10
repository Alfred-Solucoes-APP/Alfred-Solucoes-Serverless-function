create table if not exists security_user_devices (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    device_id text not null,
    device_name text,
    user_agent text,
    ip_address text,
    locale text,
    timezone text,
    screen text,
    status text not null default 'pending',
    approval_token text,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    confirmed_at timestamptz,
    last_seen_at timestamptz
);

create unique index if not exists security_user_devices_user_device_idx on security_user_devices(user_id, device_id);
create index if not exists security_user_devices_token_idx on security_user_devices(approval_token);

alter table security_user_devices
    add constraint security_user_devices_status_check
    check (status in ('pending', 'approved'));

create table if not exists security_login_events (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    device_id text,
    device_name text,
    ip_address text,
    user_agent text,
    locale text,
    timezone text,
    metadata jsonb,
    created_at timestamptz not null default timezone('utc', now())
);

create index if not exists security_login_events_user_idx on security_login_events(user_id, created_at desc);

create or replace function security_touch_user_device()
returns trigger as $$
begin
    new.updated_at := timezone('utc', now());
    return new;
end;
$$ language plpgsql;

create trigger security_user_devices_set_updated
    before update on security_user_devices
    for each row
    execute function security_touch_user_device();
