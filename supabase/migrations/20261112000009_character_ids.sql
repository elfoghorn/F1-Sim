-- F1 SIM: character IDs issued by the database.
-- A new character's ID is "CH-" and eight characters from letters and digits without O, 0, I or 1,
-- drawn from a secure random source and checked against every character already saved, so it is unique.
-- The site saves a new character with an insert (never an upsert), so an ID in use is refused rather than overwritten;
-- the docs table's primary key (collection, id) guarantees it.

create or replace function public.new_character_id() returns text
language plpgsql volatile security definer set search_path = public, extensions as $$
declare alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; b bytea; candidate text; i int; tries int := 0;
begin
    if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
    loop
        b := extensions.gen_random_bytes(8); candidate := 'CH-';
        -- 32 characters, so each random byte maps evenly onto one of them.
        for i in 0..7 loop candidate := candidate || substr(alphabet, (get_byte(b, i) % 32) + 1, 1); end loop;
        exit when not exists (select 1 from public.docs where collection = 'characters' and id = candidate);
        tries := tries + 1;
        if tries > 20 then raise exception 'Could not find a free character ID'; end if;
    end loop;
    return candidate;
end $$;

revoke execute on function public.new_character_id() from public, anon;
grant execute on function public.new_character_id() to authenticated;
