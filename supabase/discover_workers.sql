-- Run this in Supabase SQL Editor to see what columns exist on the workers table.
-- The supervisor portal now uses select('*') and accepts any column naming
-- variant, so this is purely informational / for your reference.

select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'workers' and table_schema = 'public'
order by ordinal_position;

-- Same for attendance:
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'attendance' and table_schema = 'public'
order by ordinal_position;
