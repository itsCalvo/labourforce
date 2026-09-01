-- Functions for Stage Approval Workflow
-- Run this AFTER stage_workflow_rls_policies.sql

-- Function to advance workflow to next stage
CREATE OR REPLACE FUNCTION public.advance_workflow_stage(
    p_attendance_id uuid,
    p_stage_name text,
    p_approver_id uuid,
    p_approver_name text,
    p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_current_stage text;
    v_next_stage text;
    v_stage_order int;
BEGIN
    SELECT current_stage INTO v_current_stage
    FROM public.attendance
    WHERE id = p_attendance_id;

    IF v_current_stage IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Attendance record not found');
    END IF;

    SELECT stage_order INTO v_stage_order
    FROM public.stage_definitions
    WHERE stage_name = v_current_stage;

    SELECT stage_name INTO v_next_stage
    FROM public.stage_definitions
    WHERE stage_order = v_stage_order + 1 AND is_active = true;

    UPDATE public.approval_stages
    SET status = 'approved',
        approver_id = p_approver_id,
        approver_name = p_approver_name,
        approved_at = now(),
        notes = p_notes,
        updated_at = now()
    WHERE attendance_id = p_attendance_id
      AND stage_name = p_stage_name
      AND status = 'pending';

    IF v_next_stage IS NULL THEN
        UPDATE public.attendance
        SET workflow_status = 'approved',
            final_approved_at = now(),
            final_approved_by = p_approver_id
        WHERE id = p_attendance_id;
    ELSE
        UPDATE public.attendance
        SET current_stage = v_next_stage
        WHERE id = p_attendance_id;

        INSERT INTO public.approval_stages (attendance_id, stage_name, stage_order, status)
        VALUES (p_attendance_id, v_next_stage, v_stage_order + 1, 'pending')
        ON CONFLICT DO NOTHING;
    END IF;

    INSERT INTO public.workflow_events (
        attendance_id, event_type, stage_name, actor_id, actor_name,
        previous_status, new_status, metadata
    )
    VALUES (
        p_attendance_id, 'stage_approved', p_stage_name, p_approver_id, p_approver_name,
        v_current_stage, COALESCE(v_next_stage, 'approved'),
        jsonb_build_object('notes', p_notes, 'is_final', v_next_stage IS NULL)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'previous_stage', v_current_stage,
        'next_stage', v_next_stage,
        'is_final', v_next_stage IS NULL
    );
END;
$$;

-- Function to reject workflow at current stage
CREATE OR REPLACE FUNCTION public.reject_workflow_stage(
    p_attendance_id uuid,
    p_stage_name text,
    p_approver_id uuid,
    p_approver_name text,
    p_rejection_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE public.approval_stages
    SET status = 'rejected',
        approver_id = p_approver_id,
        approver_name = p_approver_name,
        approved_at = now(),
        rejection_reason = p_rejection_reason,
        updated_at = now()
    WHERE attendance_id = p_attendance_id
      AND stage_name = p_stage_name
      AND status = 'pending';

    UPDATE public.attendance
    SET workflow_status = 'rejected'
    WHERE id = p_attendance_id;

    INSERT INTO public.workflow_events (
        attendance_id, event_type, stage_name, actor_id, actor_name,
        previous_status, new_status, metadata
    )
    VALUES (
        p_attendance_id, 'stage_rejected', p_stage_name, p_approver_id, p_approver_name,
        p_stage_name, 'rejected',
        jsonb_build_object('rejection_reason', p_rejection_reason)
    );

    RETURN jsonb_build_object('ok', true);
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.advance_workflow_stage TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_workflow_stage TO authenticated;
