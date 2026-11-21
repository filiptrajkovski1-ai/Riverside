begin;
create table if not exists public.portal_members (
 slot smallint primary key check (slot in (1,2)),
 user_id uuid not null unique references auth.users(id) on delete cascade
);
alter table public.portal_members enable row level security;
revoke all on public.portal_members from public, anon, authenticated;
grant select on public.portal_members to authenticated;
drop policy if exists own_membership on public.portal_members;
create policy own_membership on public.portal_members for select to authenticated using (user_id=(select auth.uid()));

create table if not exists public.units (
 id integer primary key,
 kind text not null check (kind in ('apartment','parking')),
 number integer not null check (number between 1 and 55),
 floor smallint not null,
 area numeric(8,2) not null,
 type text not null,
 status text not null default 'available' check (status in ('available','reserved','sold')),
 owner text not null default '' check (length(owner)<=300),
 phone text not null default '' check (length(phone)<=100),
 notes text not null default '' check (length(notes)<=12000),
 annotations jsonb not null default '[]'::jsonb check (jsonb_typeof(annotations)='array' and jsonb_array_length(annotations)<=400),
 revision integer not null default 1 check (revision>0),
 updated_at timestamptz not null default now(),
 updated_by uuid references auth.users(id),
 unique(kind,number)
);
alter table public.units enable row level security;
revoke all on public.units from public, anon, authenticated;
grant select on public.units to authenticated;
drop policy if exists members_read_units on public.units;
create policy members_read_units on public.units for select to authenticated using (
 exists(select 1 from public.portal_members where user_id=(select auth.uid()))
);

create or replace function public.valid_portal_marks(marks jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare mark jsonb; point jsonb;
begin
 if jsonb_typeof(marks) is distinct from 'array' or jsonb_array_length(marks)>400 then return false; end if;
 for mark in select value from jsonb_array_elements(marks) loop
  if jsonb_typeof(mark) is distinct from 'object' or mark->>'kind' not in ('point','path') or mark->>'kind' is null then return false; end if;
  if length(coalesce(mark->>'text',''))>500 or jsonb_typeof(mark->'points') is distinct from 'array' then return false; end if;
  if jsonb_array_length(mark->'points')<1 or jsonb_array_length(mark->'points')>1500 then return false; end if;
  for point in select value from jsonb_array_elements(mark->'points') loop
   if jsonb_typeof(point) is distinct from 'array' or jsonb_array_length(point)<>2 then return false; end if;
   if jsonb_typeof(point->0) is distinct from 'number' or jsonb_typeof(point->1) is distinct from 'number' then return false; end if;
   if (point->>0)::numeric not between 0 and 1 or (point->>1)::numeric not between 0 and 1 then return false; end if;
  end loop;
 end loop;
 return true;
exception when others then return false;
end;
$$;
revoke all on function public.valid_portal_marks(jsonb) from public;
create or replace function public.save_portal_unit(
 p_id integer,p_revision integer,p_status text,p_owner text,p_phone text,p_notes text,p_annotations jsonb
) returns public.units language plpgsql security definer set search_path='' as $$
declare result public.units;
begin
 if auth.uid() is null or not exists(select 1 from public.portal_members where user_id=auth.uid()) then
  raise exception 'RIVERSIDE_FORBIDDEN' using errcode='42501';
 end if;
 if not public.valid_portal_marks(p_annotations) then raise exception 'RIVERSIDE_INVALID_MARKS' using errcode='22023'; end if;
 update public.units set status=p_status,owner=p_owner,phone=p_phone,notes=p_notes,annotations=p_annotations,
 revision=revision+1,updated_at=clock_timestamp(),updated_by=auth.uid()
 where id=p_id and revision=p_revision returning * into result;
 if not found then raise exception 'RIVERSIDE_CONFLICT' using errcode='40001'; end if;
 return result;
end;
$$;
revoke all on function public.save_portal_unit(integer,integer,text,text,text,text,jsonb) from public,anon;
grant execute on function public.save_portal_unit(integer,integer,text,text,text,text,jsonb) to authenticated;
commit;
