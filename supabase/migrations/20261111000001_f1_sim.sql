-- =====================================================================
-- F1 SIM: database set-up (for a new Supabase project).
--   members   one row per account: owner (Administrator and Race
--             Control), mod (Race Control) or player. The first account
--             to sign up becomes the owner.
--   docs      the league's records, one row per record, by collection.
--   assets    a public Storage bucket for uploaded images.
-- Rules (row-level security):
--   * Only signed-in members read anything.
--   * Race Control alone writes the grid, ratings, circuits, race
--     weekends and settings.
--   * Characters, seat applications, paddock posts and pit-wall calls
--     belong to the account that made them: only that account (or Race
--     Control) can change or delete them.
--   * Each person's private storage (data/users/<id>) is theirs alone.
-- Grants are explicit: new Supabase projects don't expose tables to the
-- Data API automatically.
-- =====================================================================
create extension if not exists pgcrypto with schema extensions;

create table public.members (
    user_id     uuid primary key references auth.users (id) on delete cascade,
    username    text not null,
    role        text not null default 'player' check (role in ('owner', 'mod', 'player')),
    mod_tools   text[] not null default '{}',
    created_at  timestamptz not null default now()
);
create unique index members_username_key on public.members (lower(username));

create table public.docs (
    collection  text not null check (length(collection) between 1 and 200),
    id          text not null check (length(id) between 1 and 200),
    data        jsonb not null,
    updated_at  timestamptz not null default now(),
    updated_by  uuid default auth.uid(),
    primary key (collection, id)
);

-- ---------------------------------------------------------------- helpers
create function public.my_role() returns text
language sql stable security definer set search_path = public as $$
    select role from public.members where user_id = auth.uid()
$$;
create function public.is_gm() returns boolean
language sql stable security definer set search_path = public as $$
    select coalesce((select role in ('owner', 'mod') from public.members where user_id = auth.uid()), false)
$$;
create function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.members where user_id = auth.uid())
$$;
-- Collections only Race Control may change.
create function public.gm_only_collection(c text) returns boolean
language sql immutable as $$
    select c = any (array['f1_teams', 'f1_people', 'f1_seats', 'f1_tracks', 'f1_weekends', 'f1_settings'])
$$;
-- Collections whose records belong to the account named in data.userId.
create function public.owned_collection(c text) returns boolean
language sql immutable as $$
    select c = any (array['characters', 'f1_applications', 'f1_posts', 'f1_calls'])
$$;
create function public.own_private(c text) returns boolean
language sql stable as $$
    select c = 'data/users/' || auth.uid()::text or c like 'data/users/' || auth.uid()::text || '/%'
$$;
create function public.may_read(c text) returns boolean
language sql stable security definer set search_path = public as $$
    select case when c like 'data/users/%' then public.own_private(c) else public.is_member() end
$$;
create function public.may_write(c text) returns boolean
language sql stable security definer set search_path = public as $$
    select case when c like 'data/users/%' then public.own_private(c)
                when public.gm_only_collection(c) then public.is_gm()
                else public.is_member() end
$$;
create function public.owns(c text, d jsonb) returns boolean
language sql stable security definer set search_path = public as $$
    select not public.owned_collection(c) or public.is_gm() or (d ->> 'userId') = auth.uid()::text
$$;

create function public.docs_touch() returns trigger
language plpgsql as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
create trigger docs_touch before insert or update on public.docs for each row execute function public.docs_touch();

-- ---------------------------------------------------------------- accounts
create function public.handle_new_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    insert into public.members (user_id, username, role)
    values (new.id, lower(coalesce(nullif(new.raw_user_meta_data ->> 'username', ''), split_part(new.email, '@', 1))),
            case when exists (select 1 from public.members) then 'player' else 'owner' end);
    return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_member();

-- Only the Administrator changes roles; nobody makes themselves owner; usernames are fixed.
create function public.guard_member_role() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if auth.uid() is not null then
        if (new.role is distinct from old.role or new.mod_tools is distinct from old.mod_tools) and coalesce(public.my_role(), '') <> 'owner' then
            raise exception 'Only the Administrator changes roles' using errcode = '42501';
        end if;
        if new.role = 'owner' and old.role <> 'owner' then
            raise exception 'There is one Administrator' using errcode = '42501';
        end if;
        if new.user_id is distinct from old.user_id or new.username is distinct from old.username then
            raise exception 'Usernames are fixed once created' using errcode = '42501';
        end if;
    end if;
    if new.role <> 'mod' then new.mod_tools := '{}'; end if;
    return new;
end $$;
create trigger members_guard before update on public.members for each row execute function public.guard_member_role();

create function public.admin_reset_password(p_user uuid, p_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
    if coalesce(public.my_role(), '') <> 'owner' then raise exception 'Only the Administrator resets passwords' using errcode = '42501'; end if;
    if p_user = auth.uid() then raise exception 'Change your own password from the account menu' using errcode = '42501'; end if;
    if length(coalesce(p_password, '')) < 8 then raise exception 'Use a password of at least 8 characters'; end if;
    update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now() where id = p_user;
    if not found then raise exception 'No such account'; end if;
    delete from auth.sessions where user_id = p_user;
end $$;
create function public.admin_delete_account(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
    if coalesce(public.my_role(), '') <> 'owner' then raise exception 'Only the Administrator deletes accounts' using errcode = '42501'; end if;
    if p_user = auth.uid() then raise exception 'The Administrator account cannot delete itself' using errcode = '42501'; end if;
    delete from auth.users where id = p_user;
    if not found then raise exception 'No such account'; end if;
end $$;

-- Invite code: stored only as a one-way hash, in a schema the site can't read.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.config (key text primary key, value text not null);
create function public.check_invite() returns trigger
language plpgsql security definer set search_path = public, private, extensions as $$
declare h text; given text := new.raw_user_meta_data ->> 'invite';
begin
    select value into h from private.config where key = 'invite_hash';
    if h is not null and exists (select 1 from public.members) then
        if given is null or extensions.crypt(given, h) <> h then
            raise exception 'invite_code_invalid' using errcode = '42501';
        end if;
    end if;
    new.raw_user_meta_data := coalesce(new.raw_user_meta_data, '{}'::jsonb) - 'invite';
    return new;
end $$;
create trigger on_auth_user_invite before insert on auth.users for each row execute function public.check_invite();
create function public.admin_set_invite_code(p_code text) returns void
language plpgsql security definer set search_path = public, private, extensions as $$
begin
    if coalesce(public.my_role(), '') <> 'owner' then raise exception 'Only the Administrator sets the invite code' using errcode = '42501'; end if;
    if coalesce(trim(p_code), '') = '' then delete from private.config where key = 'invite_hash'; return; end if;
    if length(trim(p_code)) < 6 then raise exception 'Use an invite code of at least 6 characters'; end if;
    insert into private.config (key, value) values ('invite_hash', extensions.crypt(trim(p_code), extensions.gen_salt('bf')))
    on conflict (key) do update set value = excluded.value;
end $$;
create function public.invite_required() returns boolean
language sql stable security definer set search_path = public, private as $$
    select exists (select 1 from private.config where key = 'invite_hash') and exists (select 1 from public.members)
$$;

-- ---------------------------------------------------------------- row-level security
alter table public.members enable row level security;
alter table public.docs enable row level security;

create policy members_read on public.members for select to authenticated using (public.is_member());
create policy members_update on public.members for update to authenticated
    using (user_id = auth.uid() or public.my_role() = 'owner') with check (user_id = auth.uid() or public.my_role() = 'owner');

create policy docs_read   on public.docs for select to authenticated using (public.may_read(collection));
create policy docs_insert on public.docs for insert to authenticated
    with check (public.may_write(collection) and public.owns(collection, data));
create policy docs_update on public.docs for update to authenticated
    using (public.may_write(collection) and public.owns(collection, data))
    with check (public.may_write(collection) and public.owns(collection, data));
create policy docs_delete on public.docs for delete to authenticated
    using (public.may_write(collection) and public.owns(collection, data));

-- ---------------------------------------------------------------- grants
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.docs to authenticated;
grant select, update on public.members to authenticated;
grant execute on function public.my_role(), public.is_gm(), public.is_member(), public.gm_only_collection(text), public.owned_collection(text),
                          public.own_private(text), public.may_read(text), public.may_write(text), public.owns(text, jsonb) to authenticated;
revoke execute on function public.admin_reset_password(uuid, text), public.admin_delete_account(uuid), public.admin_set_invite_code(text) from public, anon;
grant execute on function public.admin_reset_password(uuid, text), public.admin_delete_account(uuid), public.admin_set_invite_code(text) to authenticated;
grant execute on function public.invite_required() to anon, authenticated;

-- Keep-awake ping for the scheduled GitHub job (returns nothing private).
create function public.keepalive() returns text language sql stable as $$ select 'ok'::text $$;
grant execute on function public.keepalive() to anon, authenticated;

-- ---------------------------------------------------------------- live updates
alter table public.docs replica identity full;
do $$ begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        alter publication supabase_realtime add table public.docs;
    end if;
end $$;

-- ---------------------------------------------------------------- image storage
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('assets', 'assets', true, 15728640, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do nothing;
create policy "assets: members upload" on storage.objects for insert to authenticated
    with check (bucket_id = 'assets' and public.is_member());
create policy "assets: members list" on storage.objects for select to authenticated
    using (bucket_id = 'assets');
create policy "assets: owner or Race Control removes" on storage.objects for delete to authenticated
    using (bucket_id = 'assets' and (owner_id = auth.uid()::text or public.is_gm()));
