-- =====================================================================
-- F1 SIM: accounts made before the database set-up ran.
-- Signing up creates the account in Supabase Auth; a trigger then adds
-- its row to public.members. Accounts created before that trigger
-- existed have no row, and sign-in stops at "Your account isn't set up
-- in the database yet". This adds the missing rows, as players, and
-- makes elfoghorn the Administrator if there isn't one yet.
-- Safe to run more than once.
-- =====================================================================
insert into public.members (user_id, username, role)
select u.id,
       lower(coalesce(nullif(u.raw_user_meta_data ->> 'username', ''), split_part(u.email, '@', 1))),
       'player'
  from auth.users u
 where not exists (select 1 from public.members m where m.user_id = u.id)
 order by u.created_at
on conflict do nothing;

update public.members
   set role = 'owner'
 where lower(username) = 'elfoghorn'
   and not exists (select 1 from public.members where role = 'owner');

-- From now on, elfoghorn becomes the Administrator on signing up if the
-- league has none; otherwise the first account does, and everyone else
-- is a player.
create or replace function public.handle_new_member() returns trigger
language plpgsql security definer set search_path = public as $$
declare uname text := lower(coalesce(nullif(new.raw_user_meta_data ->> 'username', ''), split_part(new.email, '@', 1)));
begin
    insert into public.members (user_id, username, role)
    values (new.id, uname,
            case when not exists (select 1 from public.members where role = 'owner')
                      and (uname = 'elfoghorn' or not exists (select 1 from public.members)) then 'owner'
                 else 'player' end);
    return new;
end $$;
