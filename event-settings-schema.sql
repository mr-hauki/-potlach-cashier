create table if not exists public.event_settings (
  event_id text primary key,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.event_settings enable row level security;

drop policy if exists potlach_event_settings_select on public.event_settings;
drop policy if exists potlach_event_settings_insert on public.event_settings;
drop policy if exists potlach_event_settings_update on public.event_settings;

create policy potlach_event_settings_select
  on public.event_settings
  for select
  to anon, authenticated
  using (event_id = 'potlach-24-2026');

create policy potlach_event_settings_insert
  on public.event_settings
  for insert
  to anon, authenticated
  with check (event_id = 'potlach-24-2026');

create policy potlach_event_settings_update
  on public.event_settings
  for update
  to anon, authenticated
  using (event_id = 'potlach-24-2026')
  with check (event_id = 'potlach-24-2026');

grant select, insert, update
  on public.event_settings
  to anon, authenticated;
