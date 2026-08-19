THE LABOUR FORCE — CLOUD-FIRST WORKFORCE COMMAND CENTRE

Files
-----
index.html       Main application shell
styles.css       Futuristic Labour Force interface
config.js        Supabase project URL + anon key
supabase.js      Local-first cloud sync, reconnect recovery and authentication
app.js           Core workforce operations
advanced.js      Deployments, availability, exceptions and audit UI
data.js          Local cache / recovery state
schema_patch.sql Small patch for audit inserts + admin bootstrap

How the data model works
------------------------
1. The browser saves every change to localStorage immediately.
2. When Supabase is connected, the same change is queued for cloud sync.
3. If power/internet disappears, work remains in localStorage.
4. On reconnect, the pending local state is pushed before cloud hydration.
5. Supabase is the shared source of truth; localStorage is the recovery layer.
6. Audit events identify the authenticated user and operation.

Important setup
---------------
The database schema you supplied should already be executed.
Then run schema_patch.sql in Supabase SQL Editor.

Create an administrator in:
Authentication -> Users -> Add user

Then run the commented bootstrap INSERT in schema_patch.sql after replacing
YOUR-ADMIN-EMAIL@example.com with the administrator's real email.

Open index.html. The Labour Force app works locally without login. Click
Connect to sign in and enable cloud persistence and role-based access.

Security
--------
Only the Supabase anon key belongs in frontend code. Never put a service-role
key in this folder or in browser JavaScript. Keep RLS enabled.

The existing role/permission tables in the supplied schema control what an
authenticated profile can do. The frontend provides convenience checks, but
RLS remains the actual database security boundary.


USER & ACCESS CENTRE
====================
The application now includes Users & Access for administrators.

1. Run schema_patch.sql in the Supabase SQL Editor.
2. Deploy supabase/functions/manage-users/index.ts as an Edge Function named manage-users.
3. Keep the service-role key only inside Supabase; never put it in config.js.
4. Bootstrap the first Labour Force super_admin using the commented SQL at the bottom of schema_patch.sql.
5. Sign in through the Labour Force Connect button.
6. Administrators can create users, change roles, activate/deactivate accounts and see role permissions from Users & Access.

The browser still saves locally first. Supabase is the cloud source of truth and localStorage is the recovery layer.
