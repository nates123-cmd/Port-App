-- Port #8 image attachments — storage RLS for the private `port-uploads` bucket.
-- Run ONCE in the Supabase dashboard → SQL editor. (DDL on storage.objects can't be done
-- with the service key from the box, so this is the only manual step for image attach.)
--
-- The bucket itself is already created (private, 15 MB limit, image mime types only).
-- These policies let a signed-in user upload to / read from their OWN folder (named by
-- their auth user id). The daemon reads uploads with the service key, which bypasses RLS.

create policy "port-uploads insert own"
  on storage.objects for insert to authenticated
  with check ( bucket_id = 'port-uploads' and (storage.foldername(name))[1] = auth.uid()::text );

create policy "port-uploads read own"
  on storage.objects for select to authenticated
  using ( bucket_id = 'port-uploads' and (storage.foldername(name))[1] = auth.uid()::text );
