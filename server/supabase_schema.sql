-- ==========================================================
-- SCRIPT SQL PARA SUPABASE (PronoXI Fútbol & Pronósticos IA)
-- Pega este script en el SQL Editor de tu Dashboard de Supabase
-- ==========================================================

-- 1. Tabla de predicciones y análisis de IA
create table if not exists public.predictions (
  fixture_id text primary key,
  date text,
  status text,
  payload jsonb not null,
  created_at bigint default (extract(epoch from now()) * 1000)::bigint,
  updated_at timestamp with time zone default timezone('utc'::text, now())
);

-- Índices de consulta rápida por fecha y estado
create index if not exists idx_predictions_date on public.predictions(date);
create index if not exists idx_predictions_created on public.predictions(created_at desc);

-- 2. Tabla de caché para respuestas de API de fútbol
create table if not exists public.api_cache (
  path text primary key,
  payload jsonb not null,
  updated_at bigint default (extract(epoch from now()) * 1000)::bigint
);

-- 3. Habilitar Row Level Security (RLS)
alter table public.predictions enable row level security;
alter table public.api_cache enable row level security;

-- 4. Políticas para permitir lectura y guardado con la Anon Key o Service Role
drop policy if exists "Permitir lectura publica de predicciones" on public.predictions;
create policy "Permitir lectura publica de predicciones"
  on public.predictions for select
  using (true);

drop policy if exists "Permitir insercion y actualizacion de predicciones" on public.predictions;
create policy "Permitir insercion y actualizacion de predicciones"
  on public.predictions for all
  using (true)
  with check (true);

drop policy if exists "Permitir lectura publica de api_cache" on public.api_cache;
create policy "Permitir lectura publica de api_cache"
  on public.api_cache for select
  using (true);

drop policy if exists "Permitir insercion y actualizacion de api_cache" on public.api_cache;
create policy "Permitir insercion y actualizacion de api_cache"
  on public.api_cache for all
  using (true)
  with check (true);
