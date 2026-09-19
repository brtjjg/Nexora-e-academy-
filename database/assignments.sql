CREATE TABLE IF NOT EXISTS assignments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id       UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    module_id       UUID REFERENCES modules(id) ON DELETE CASCADE,
    lesson_id       UUID REFERENCES lessons(id) ON DELETE SET NULL,
    title           TEXT NOT NULL,
    instructions    TEXT,
    max_marks       INTEGER NOT NULL DEFAULT 20 CHECK (max_marks > 0),
    allow_text      BOOLEAN NOT NULL DEFAULT TRUE,
    allow_file      BOOLEAN NOT NULL DEFAULT TRUE,
    allowed_file_types TEXT NOT NULL DEFAULT 'pdf,docx,jpg,png',
    max_file_mb     INTEGER NOT NULL DEFAULT 10,
    due_date        TIMESTAMPTZ,
    allow_resubmission BOOLEAN NOT NULL DEFAULT TRUE,
    max_attempts    INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts > 0),
    status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
    weight_percent  NUMERIC(5,2) NOT NULL DEFAULT 0,
    position        INTEGER NOT NULL DEFAULT 1,
    late_policy     TEXT DEFAULT 'allow',
    late_penalty_percent INTEGER DEFAULT 10,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assignments_course ON assignments(course_id);
CREATE INDEX IF NOT EXISTS idx_assignments_module ON assignments(module_id);
CREATE INDEX IF NOT EXISTS idx_assignments_status ON assignments(status);

CREATE TABLE IF NOT EXISTS assignment_submissions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assignment_id   UUID NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    student_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attempt_number  INTEGER NOT NULL DEFAULT 1,
    text_answer     TEXT,
    file_path       TEXT,
    file_name       TEXT,
    file_type       TEXT,
    file_size       BIGINT,
    status          TEXT NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('submitted','marked','returned','resubmitted','rejected')),
    marks           NUMERIC(6,2),
    percentage      NUMERIC(6,2),
    feedback        TEXT,
    marked_at       TIMESTAMPTZ,
    marked_by       UUID REFERENCES users(id),
    return_reason   TEXT,
    returned_at     TIMESTAMPTZ,
    is_late         BOOLEAN DEFAULT FALSE,
    penalty_percent INTEGER DEFAULT 0,
    submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_submissions_assignment ON assignment_submissions(assignment_id);
CREATE INDEX IF NOT EXISTS idx_submissions_student ON assignment_submissions(student_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON assignment_submissions(status);

CREATE TABLE IF NOT EXISTS assignment_history (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id   UUID NOT NULL REFERENCES assignment_submissions(id) ON DELETE CASCADE,
    action          TEXT NOT NULL,
    note            TEXT,
    performed_by    UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assignment_history_submission ON assignment_history(submission_id);

CREATE TABLE IF NOT EXISTS notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type            TEXT NOT NULL,
    title           TEXT NOT NULL,
    body            TEXT,
    link            TEXT,
    read            BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
