# Labour Force — User Management Deployment

## 1. Database

Open Supabase SQL Editor and run:

`schema_patch.sql`

This adds administrator user-management permissions, profile update protection, and the missing audit-log insert policy.

## 2. Create the Edge Function

In Supabase Dashboard:

**Edge Functions → Create a new function**

Name it:

`manage-users`

Replace its `index.ts` with:

`supabase/functions/manage-users/index.ts`

Deploy it.

Supabase supplies these environment variables to Edge Functions automatically:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

The service-role key must remain inside the Edge Function environment and must never be added to `config.js` or browser JavaScript.

## 3. Bootstrap the first administrator

Create an Auth user in **Authentication → Users**.

Copy the Auth user's UUID.

In `schema_patch.sql`, uncomment the bootstrap INSERT and replace:

- `AUTH-USER-UUID-HERE`
- `Your Name`
- `your@email.com`

with the real values.

Set the role to `super_admin` for the first account.

## 4. Use the frontend

Sign in with the Connect button.

Open:

**Users & Access**

From there an administrator can:

- create Labour Force users;
- assign HR, Supervisor, Payroll, Administrator, Client or Viewer roles;
- promote/demote users by changing their role;
- activate/deactivate accounts;
- inspect the permissions attached to each role.

Every create or access change is written to `audit_logs`.

## 5. Security model

The browser never receives the service-role key.

The browser sends the logged-in user's access token to `manage-users`.

The Edge Function verifies the caller and only permits `super_admin` or `administrator` to manage users. A non-super-admin cannot assign or modify the `super_admin` role, and a user cannot change their own role/status through the User Management screen.
