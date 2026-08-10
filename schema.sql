-- ============================================================
-- RRA BOATHOUSE: database schema + starting data
-- Run this ONCE in Supabase: SQL Editor > New query > paste all > Run
-- Safe to re-run on an empty project (drops and recreates everything).
-- ============================================================

drop table if exists log, reservations, flags, boats, roster, settings cascade;
create extension if not exists btree_gist;

-- ------------------------------------------------------------ boats --------
create table boats (
  id serial primary key,
  name text unique not null,
  type text not null,                    -- 1x, 2x, 4x, 4+
  quick_release boolean not null default false,
  status text not null default 'Available',   -- Available | Out of service
  uses_total integer not null default 0,
  uses_since_service integer not null default 0,
  service_interval integer not null default 50,
  last_serviced date,
  notes text not null default ''
);

-- ------------------------------------------------------------ roster -------
create table roster (
  id serial primary key,
  name text unique not null,
  program text not null default 'Masters',
  active boolean not null default true
);

-- ------------------------------------------------------------ log ----------
create table log (
  id serial primary key,
  boat text not null,
  own_boat boolean not null default false,
  rower text not null,
  crew text not null default '',
  out_at timestamptz not null default now(),
  in_at timestamptz,
  minutes integer,
  issue_reported text not null default ''
);

-- A club boat can have only ONE open outing at a time (database-enforced,
-- so two phones checking out the same boat in the same second cannot both win).
create unique index one_open_club_outing_per_boat
  on log (boat) where (in_at is null and own_boat = false);

-- ------------------------------------------------------------ reservations -
create table reservations (
  id serial primary key,
  date date not null,
  start_min integer not null,            -- minutes since midnight, club time
  end_min integer not null,
  boat text not null,
  name text not null,
  status text not null default 'Booked', -- Booked | Cancelled | Fulfilled
  created_at timestamptz not null default now(),
  check (end_min > start_min)
);

-- Overlapping bookings for the same boat on the same day are rejected
-- by the database itself.
alter table reservations add constraint no_overlapping_bookings
  exclude using gist (
    boat with =,
    date with =,
    int4range(start_min, end_min) with &&
  ) where (status = 'Booked');

-- ------------------------------------------------------------ flags --------
create table flags (
  id serial primary key,
  boat text not null,
  issue text not null,
  reported_by text not null default '',
  reported_on date not null default current_date,
  status text not null default 'Open',   -- Open | Resolved
  resolved_on date
);

-- ------------------------------------------------------------ settings -----
create table settings (
  key text primary key,
  value integer not null
);

-- Lock the tables down: row level security ON with no public policies.
-- The Vercel functions use the service role key, which bypasses RLS.
-- Anyone who somehow gets the anon key still gets nothing.
alter table boats enable row level security;
alter table roster enable row level security;
alter table log enable row level security;
alter table reservations enable row level security;
alter table flags enable row level security;
alter table settings enable row level security;

-- ============================================================
-- STARTING DATA (Aug 2026 quick release inventory)
-- ============================================================

insert into settings (key, value) values
  ('max_outing_hours', 3),
  ('default_service_interval', 50),
  ('reservation_window_days', 14);

insert into boats (name, type, quick_release, status, notes) values
  ('BLACK HUDSON #2',      '1x', true,  'Available', ''),
  ('BLACK HUDSON #3',      '1x', true,  'Available', ''),
  ('RED KANGHUA',          '1x', true,  'Available', ''),
  ('RED HUDSON',           '1x', true,  'Available', ''),
  ('BANTAM ONE',           '1x', false, 'Available', ''),
  ('BANTAM TWO',           '1x', false, 'Available', ''),
  ('SUPER FLY ONE',        '1x', false, 'Available', ''),
  ('SUPER FLY TWO',        '1x', false, 'Available', ''),
  ('WHITE SINGLE',         '1x', false, 'Out of service', 'Missing plate and footstretcher'),
  ('FISA WHITE SINGLE',    '1x', false, 'Out of service', 'Missing plate and footstretcher'),
  ('EXPLORER 24',          '1x', false, 'Out of service', 'Missing plate and footstretcher'),
  ('LIGHTWEIGHT EMPACHER', '1x', false, 'Out of service', 'Need to order a base plate that fits so the quick release system can be installed'),
  ('BLACK SINGLE',         '1x', false, 'Out of service', 'Missing plate and footstretcher'),
  ('WHITE HUDSON',         '1x', false, 'Out of service', 'Missing plate and footstretcher'),
  ('PANTHER',              '2x', true,  'Available', ''),
  ('SWORDFISH',            '2x', true,  'Available', ''),
  ('BLUEFIN',              '2x', true,  'Available', ''),
  ('WILLIAM H.',           '2x', true,  'Available', ''),
  ('THOMAS WILKINSON',     '2x', true,  'Available', ''),
  ('HAMMERHEAD',           '2x', true,  'Available', ''),
  ('VICTORY',              '2x', true,  'Available', ''),
  ('JAMES CONNOR',         '2x', true,  'Available', ''),
  ('GEMINI',               '2x', false, 'Available', ''),
  ('LEOPARD',              '4x', true,  'Available', ''),
  ('SAILFISH',             '4x', true,  'Available', ''),
  ('CHEETAH',              '4x', true,  'Available', ''),
  ('CRESTON II',           '4x', true,  'Available', ''),
  ('JAGUAR',               '4+', true,  'Available', ''),
  ('PUMA',                 '4+', true,  'Available', '');

insert into flags (boat, issue, reported_by, reported_on) values
  ('PANTHER',              'Missing cover',                                                  'Inventory import', '2026-08-09'),
  ('VICTORY',              'Need heel ties',                                                 'Inventory import', '2026-08-09'),
  ('JAMES CONNOR',         'Need heel ties',                                                 'Inventory import', '2026-08-09'),
  ('LEOPARD',              'Need to change 3 seat footplate',                                'Inventory import', '2026-08-09'),
  ('SAILFISH',             'Need heel ties',                                                 'Inventory import', '2026-08-09'),
  ('CHEETAH',              'Need heel ties',                                                 'Inventory import', '2026-08-09'),
  ('CRESTON II',           'Need heel ties',                                                 'Inventory import', '2026-08-09'),
  ('JAGUAR',               'Need heel ties',                                                 'Inventory import', '2026-08-09'),
  ('PUMA',                 'Need heel ties',                                                 'Inventory import', '2026-08-09'),
  ('WHITE SINGLE',         'Missing plate and footstretcher',                                'Inventory import', '2026-08-09'),
  ('FISA WHITE SINGLE',    'Missing plate and footstretcher',                                'Inventory import', '2026-08-09'),
  ('EXPLORER 24',          'Missing plate and footstretcher',                                'Inventory import', '2026-08-09'),
  ('LIGHTWEIGHT EMPACHER', 'Order base plate that fits, then install quick release system',  'Inventory import', '2026-08-09'),
  ('BLACK SINGLE',         'Missing plate and footstretcher',                                'Inventory import', '2026-08-09'),
  ('WHITE HUDSON',         'Missing plate and footstretcher',                                'Inventory import', '2026-08-09');

-- Roster as tightened by Peter, Aug 10 2026 (34 masters)
insert into roster (name, program) values
  ('Alec Almond', 'Masters'), ('Allie Frost', 'Masters'), ('Amy Anil', 'Masters'),
  ('Avner Ronen', 'Masters'), ('Celeste Klose', 'Masters'), ('Chris Carroll', 'Masters'),
  ('Christopher Hely', 'Masters'), ('David Prior', 'Masters'), ('Doug Wilson', 'Masters'),
  ('Greta Nettleton', 'Masters'), ('Gregory Klugerman', 'Masters'), ('Ivan Rudolph-Shabinsky', 'Masters'),
  ('Justin Bohan', 'Masters'), ('Kathy Kearney', 'Masters'), ('Leslie Horn', 'Masters'),
  ('Lyndi Oxoby', 'Masters'), ('Maca Urdiles', 'Masters'), ('Marc Barrachin', 'Masters'),
  ('Marco Sharif', 'Masters'), ('Maskit Ronen', 'Masters'), ('Matt Hudson', 'Masters'),
  ('Megan Jones', 'Masters'), ('Michelle Wright', 'Masters'), ('Nick Ippolitto', 'Masters'),
  ('Peter Hein', 'Masters'), ('Peter Klose', 'Masters'), ('Regina Pappalardo', 'Masters'),
  ('Roger Buck', 'Masters'), ('Ryan Almond', 'Masters'), ('Sean Hundtofte', 'Masters'),
  ('Serena Yanitelli', 'Masters'), ('Sharon Quale', 'Masters'), ('Thomas Chyla', 'Masters'),
  ('Veli Etropolski', 'Masters');
