-- ============================================================
-- STAGE APPROVAL WORKFLOW - Database Schema
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. Create the approval_stages table
CREATE TABLE IF NOT EXISTS public.approval_stages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    attendance_id uuid NOT NULL,
    stage_name text NOT NULL,
    stage_order int NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    approver_id uuid REFERENCES auth.users(id),
    approver_name text,
    approved_at timestamptz,
    notes text,
    rejection_reason text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- 2. Create the workflow_events table (event-driven audit log)
CREATE TABLE IF NOT EXISTS public.workflow_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    attendance_id uuid NOT NULL,
    event_type text NOT NULL,
    stage_name text,
    actor_id uuid REFERENCES auth.users(id),
    actor_name text,
    actor_role text,
    previous_status text,
    new_status text,
    metadata jsonb DEFAULT '{}',
    created_at timestamptz DEFAULT now()
);

-- 3. Create the stage_definitions table
CREATE TABLE IF NOT EXISTS public.stage_definitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    stage_name text UNIQUE NOT NULL,
    stage_order int NOT NULL,
    required_role text NOT NULL,
    display_name text NOT NULL,
    description text,
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now()
);

-- 4. Insert default stage definitions
INSERT INTO public.stage_definitions (stage_name, stage_order, required_role, display_name, description)
VALUES
    ('supervisor', 1, 'supervisor', 'Supervisor Review', 'Supervisor verifies attendance was captured correctly'),
    ('accountant', 2, 'accounts', 'Accountant Review', 'Accountant verifies hours, rates, and OT calculations'),
    ('admin', 3, 'administrator', 'Final Approval', 'Administrator gives final approval for payroll inclusion')
ON CONFLICT (stage_name) DO NOTHING;

-- 5. Add new columns to attendance table
ALTER TABLE public.attendance
    ADD COLUMN IF NOT EXISTS current_stage text DEFAULT 'supervisor',
    ADD COLUMN IF NOT EXISTS workflow_status text DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
    ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES auth.users(id),
    ADD COLUMN IF NOT EXISTS final_approved_at timestamptz,
    ADD COLUMN IF NOT EXISTS final_approved_by uuid REFERENCES auth.users(id);

-- 6. Enable RLS
ALTER TABLE public.approval_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stage_definitions ENABLE ROW LEVEL SECURITY;

-- 7. Grant permissions
GRANT SELECT, INSERT, UPDATE ON public.approval_stages TO authenticated;
GRANT SELECT, INSERT ON public.workflow_events TO authenticated;
GRANT SELECT ON public.stage_definitions TO authenticated;
GRANT ALL ON public.stage_definitions TO authenticated;

-- 8. Create indexes
CREATE INDEX IF NOT EXISTS idx_approval_stages_attendance ON public.approval_stages(attendance_id);
CREATE INDEX IF NOT EXISTS idx_approval_stages_status ON public.approval_stages(status);
CREATE INDEX IF NOT EXISTS idx_workflow_events_attendance ON public.workflow_events(attendance_id);
CREATE INDEX IF NOT EXISTS idx_workflow_events_created ON public.workflow_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_workflow_status ON public.attendance(workflow_status);
CREATE INDEX IF NOT EXISTS idx_attendance_current_stage ON public.attendance(current_stage);
