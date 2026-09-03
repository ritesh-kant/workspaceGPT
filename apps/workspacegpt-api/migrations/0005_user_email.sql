-- GitHub email, added once the OAuth scope grew from `read:user` to
-- `read:user user:email`. Nullable: sign-ins that happened before this
-- migration have no email on file, and even new ones can come back null if
-- GitHub's email lookup fails (best-effort, does not block sign-in).
ALTER TABLE users ADD COLUMN email TEXT;
