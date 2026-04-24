-- ============================================================
-- Reservations — Friends & Family requests
--
-- Staff can request F&F treatment for a reservation; patron/responsable
-- approve or refuse. Tracked via `fnf_requested_by` (user id) + `fnf_status`.
-- ============================================================

alter table public.reservations
  add column if not exists fnf_requested_by uuid references public.profiles,
  add column if not exists fnf_status text
    check (fnf_status in ('pending', 'accepted', 'refused'));

-- Helpful index for "any pending F&F?" badge queries
create index if not exists reservations_fnf_status_idx
  on public.reservations (fnf_status)
  where fnf_status is not null;

-- Also add fields referenced by the app but missing from 005_reservations.sql
alter table public.reservations
  add column if not exists phone text;

-- Extend seating check to include 'bar' (type allows it in the app)
alter table public.reservations drop constraint if exists reservations_seating_check;
alter table public.reservations
  add constraint reservations_seating_check
  check (seating in ('interieur', 'terrasse', 'bar'));
