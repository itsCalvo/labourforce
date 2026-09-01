-- Function to submit attendance for approval workflow
-- Accepts: pending → in_progress (starts workflow), rejected → in_progress (re-submits)
-- Idempotent: in_progress → in_progress (no-op, returns ok)
CREATE OR REPLACE FUNCTION public.submit_for_approval(
    p_attendance_id uuid,
    p_submitter_id uuid,
    p_submitter_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_current_status text;
    v_first_stage text;
    v_stage_order int;
BEGIN
    SELECT workflow_status INTO v_current_status
    FROM public.attendance
    WHERE id = p_attendance_id;

    IF v_current_status IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Attendance record not found');
    END IF;

    -- Only allow from: pending, rejected, or in_progress (idempotent)
    IF NOT (v_current_status IN ('pending', 'rejected', 'in_progress')) THEN
        RETURN jsonb_build_object('ok', false, 'error',
            'Cannot submit. Record is already ' || v_current_status);
    END IF;

    -- Idempotent: if already in_progress, just confirm
    IF v_current_status = 'in_progress' THEN
        SELECT current_stage INTO v_first_stage FROM public.attendance WHERE id = p_attendance_id;
        RETURN jsonb_build_object('ok', true, 'already_in_progress', true, 'first_stage', v_first_stage);
    END IF;

    -- Get first active stage
    SELECT stage_name, stage_order INTO v_first_stage, v_stage_order
    FROM public.stage_definitions
    WHERE stage_order = 1 AND is_active = true;

    IF v_first_stage IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'No active stage definitions found');
    END IF;

    -- Reset and start workflow
    UPDATE public.attendance
    SET workflow_status = 'in_progress',
        current_stage = v_first_stage,
        -- Preserve original submitted_at on re-submission
        submitted_at = coalesce(submitted_at, now()),
        submitted_by = coalesce(submitted_by, p_submitter_id)
    WHERE id = p_attendance_id;

    -- Record this stage in approval_stages
    INSERT INTO public.approval_stages (attendance_id, stage_name, stage_order, status)
    VALUES (p_attendance_id, v_first_stage, v_stage_order, 'pending')
    ON CONFLICT DO NOTHING;

    -- Audit event
    INSERT INTO public.workflow_events (
        attendance_id, event_type, stage_name, actor_id, actor_name,
        previous_status, new_status
    )
    VALUES (
        p_attendance_id, 'submitted', v_first_stage, p_submitter_id, p_submitter_name,
        v_current_status, 'in_progress'
    );

    RETURN jsonb_build_object('ok', true, 'first_stage', v_first_stage);
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.submit_for_approval TO authenticated;
