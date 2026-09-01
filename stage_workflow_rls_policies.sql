-- RLS Policies for Stage Approval Workflow
-- Run this AFTER stage_approval_workflow.sql

-- 1. RLS Policies for approval_stages
DROP POLICY IF EXISTS "approval_stages select" ON public.approval_stages;
CREATE POLICY "approval_stages select" ON public.approval_stages
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "approval_stages insert" ON public.approval_stages;
CREATE POLICY "approval_stages insert" ON public.approval_stages
    FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "approval_stages update" ON public.approval_stages;
CREATE POLICY "approval_stages update" ON public.approval_stages
    FOR UPDATE TO authenticated USING (true);

-- 2. RLS Policies for workflow_events
DROP POLICY IF EXISTS "workflow_events select" ON public.workflow_events;
CREATE POLICY "workflow_events select" ON public.workflow_events
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "workflow_events insert" ON public.workflow_events;
CREATE POLICY "workflow_events insert" ON public.workflow_events
    FOR INSERT TO authenticated WITH CHECK (actor_id = auth.uid());

-- 3. RLS Policies for stage_definitions
DROP POLICY IF EXISTS "stage_definitions select" ON public.stage_definitions;
CREATE POLICY "stage_definitions select" ON public.stage_definitions
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "stage_definitions admin" ON public.stage_definitions;
CREATE POLICY "stage_definitions admin" ON public.stage_definitions
    FOR ALL TO authenticated
    USING (public.has_permission('users.manage'))
    WITH CHECK (public.has_permission('users.manage'));
