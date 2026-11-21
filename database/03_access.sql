-- Прво создај ги двете сметки во Authentication > Users.
-- Замени ги адресите и изврши во SQL Editor.
do $$
declare first_id uuid; second_id uuid;
begin
 select id into first_id from auth.users where lower(email)=lower('filip.trajkovski1@gmail.com');
 select id into second_id from auth.users where lower(email)=lower('COLLEAGUE_EMAIL@example.com');
 if first_id is null or second_id is null or first_id=second_id then
  raise exception 'Внеси две различни постоечки е-пошти од Authentication > Users.';
 end if;
 insert into public.portal_members(slot,user_id) values(1,first_id)
 on conflict(slot) do update set user_id=excluded.user_id;
 insert into public.portal_members(slot,user_id) values(2,second_id)
 on conflict(slot) do update set user_id=excluded.user_id;
end;
$$;
