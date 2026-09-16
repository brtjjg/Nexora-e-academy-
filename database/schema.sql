-- ============================================================
-- NEXORA ACADEMY — PRODUCTION DATABASE SCHEMA
-- Target: PostgreSQL 14+
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ============================================================
-- USERS & AUTHENTICATION
-- ============================================================

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        CITEXT UNIQUE NOT NULL,
    email           CITEXT UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    full_name       TEXT NOT NULL,
    phone           TEXT,
    date_of_birth   DATE,
    country         TEXT,
    role            TEXT NOT NULL DEFAULT 'student'
                    CHECK (role IN ('student', 'admin')),
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'archived')),
    avatar_url      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_status ON users(status);

CREATE TABLE student_profiles (
    user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    admission_number    TEXT UNIQUE,
    course_interest     TEXT,
    activation_fee_paid BOOLEAN NOT NULL DEFAULT FALSE,
    admission_status    TEXT NOT NULL DEFAULT 'pending_payment'
                        CHECK (admission_status IN
                        ('pending_payment','paid_pending_verification','approved','rejected')),
    approval_status     TEXT NOT NULL DEFAULT 'pending'
                        CHECK (approval_status IN ('pending','approved','rejected')),
    approved_at         TIMESTAMPTZ,
    approved_by         UUID REFERENCES users(id),
    rejection_reason    TEXT,
    national_id_image   TEXT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_student_profiles_admission ON student_profiles(admission_number);
CREATE INDEX idx_student_profiles_status ON student_profiles(admission_status);

CREATE TABLE sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE,
    ip_address      INET,
    user_agent      TEXT,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ============================================================
-- APPLICATIONS
-- ============================================================

CREATE TABLE applications (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id      TEXT UNIQUE NOT NULL,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    full_name           TEXT NOT NULL,
    email               CITEXT NOT NULL,
    phone               TEXT,
    date_of_birth       DATE,
    country             TEXT,
    course_interest     TEXT,
    status              TEXT NOT NULL DEFAULT 'payment_due'
                        CHECK (status IN ('payment_due','paid','approved','rejected')),
    payment_status      TEXT NOT NULL DEFAULT 'unpaid'
                        CHECK (payment_status IN ('unpaid','paid')),
    payment_reference   TEXT,
    paid_at             TIMESTAMPTZ,
    admission_number    TEXT UNIQUE,
    rejection_reason    TEXT,
    reviewed_at         TIMESTAMPTZ,
    reviewed_by         UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_applications_user ON applications(user_id);
CREATE INDEX idx_applications_status ON applications(status);
CREATE INDEX idx_applications_payment ON applications(payment_status);

CREATE TABLE application_documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id  UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    document_type   TEXT NOT NULL
                    CHECK (document_type IN
                    ('national_front','national_back','certificate','passport')),
    file_name       TEXT NOT NULL,
    storage_path    TEXT NOT NULL,
    mime_type       TEXT,
    file_size       BIGINT,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','verified','rejected')),
    rejection_reason TEXT,
    verified_at     TIMESTAMPTZ,
    verified_by     UUID REFERENCES users(id),
    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_app_docs_application ON application_documents(application_id);

CREATE TABLE application_history (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id  UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    action          TEXT NOT NULL,
    note            TEXT,
    performed_by    UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_app_history_application ON application_history(application_id);

CREATE TABLE admission_counters (
    year            INTEGER PRIMARY KEY,
    counter         INTEGER NOT NULL DEFAULT 0
);

-- ============================================================
-- COURSES & CONTENT
-- ============================================================

CREATE TABLE courses (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT NOT NULL,
    code            TEXT UNIQUE,
    category        TEXT,
    level           TEXT CHECK (level IN
                    ('Beginner','Intermediate','Advanced','Professional')),
    description     TEXT,
    instructor_name TEXT,
    duration        TEXT,
    cover_image_url TEXT,
    price           NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
    initial_payment_percent INTEGER NOT NULL DEFAULT 25
                    CHECK (initial_payment_percent BETWEEN 0 AND 100),
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','published','archived')),
    cat_pass_mark   INTEGER NOT NULL DEFAULT 50,
    exam_pass_mark  INTEGER NOT NULL DEFAULT 50,
    cat_unlock_hours INTEGER NOT NULL DEFAULT 24,
    exam_unlock_hours INTEGER NOT NULL DEFAULT 72,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_courses_status ON courses(status);
CREATE INDEX idx_courses_category ON courses(category);

CREATE TABLE course_discounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id       UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    enabled         BOOLEAN NOT NULL DEFAULT FALSE,
    original_price  NUMERIC(10,2) NOT NULL,
    discount_price  NUMERIC(10,2) NOT NULL,
    label           TEXT,
    ends_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (discount_price >= 0 AND discount_price <= original_price)
);

CREATE UNIQUE INDEX uq_course_discount_active ON course_discounts(course_id);

CREATE TABLE modules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id       UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    position        INTEGER NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_modules_course ON modules(course_id);

CREATE TABLE lessons (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id       UUID NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    description     TEXT,
    position        INTEGER NOT NULL DEFAULT 1,
    notes           TEXT,
    assignment      TEXT,
    video_url       TEXT,
    published       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lessons_module ON lessons(module_id);

CREATE TABLE lesson_attachments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lesson_id       UUID NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    attachment_type TEXT NOT NULL CHECK (attachment_type IN ('pdf','image')),
    file_name       TEXT NOT NULL,
    storage_path    TEXT NOT NULL,
    mime_type       TEXT,
    file_size       BIGINT,
    position        INTEGER NOT NULL DEFAULT 1,
    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lesson_attachments_lesson ON lesson_attachments(lesson_id);

-- ============================================================
-- ENROLLMENTS & PROGRESS
-- ============================================================

CREATE TABLE enrollments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id       UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    enrolled_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    UNIQUE (user_id, course_id)
);

CREATE INDEX idx_enrollments_user ON enrollments(user_id);
CREATE INDEX idx_enrollments_course ON enrollments(course_id);

CREATE TABLE lesson_progress (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id       UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    lesson_id       UUID NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    completed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, lesson_id)
);

CREATE INDEX idx_lesson_progress_user_course ON lesson_progress(user_id, course_id);

-- ============================================================
-- ASSESSMENTS
-- ============================================================

CREATE TABLE questions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id       UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    question_type   TEXT NOT NULL CHECK (question_type IN ('exam','cat')),
    question_text   TEXT NOT NULL,
    options         JSONB NOT NULL,
    correct_index   INTEGER NOT NULL CHECK (correct_index BETWEEN 0 AND 3),
    marks           INTEGER NOT NULL DEFAULT 1 CHECK (marks > 0),
    position        INTEGER NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_questions_course_type ON questions(course_id, question_type);

CREATE TABLE assessment_attempts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id       UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    assessment_type TEXT NOT NULL CHECK (assessment_type IN ('exam','cat')),
    score           INTEGER NOT NULL DEFAULT 0,
    total_marks     INTEGER NOT NULL,
    percentage      NUMERIC(5,2) NOT NULL,
    passed          BOOLEAN NOT NULL DEFAULT FALSE,
    answers         JSONB,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    submitted_at    TIMESTAMPTZ,
    UNIQUE (user_id, course_id, assessment_type)
);

CREATE INDEX idx_attempts_user_course ON assessment_attempts(user_id, course_id);

-- ============================================================
-- PAYMENTS
-- ============================================================

CREATE TABLE transactions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id      TEXT UNIQUE NOT NULL,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    course_id           UUID REFERENCES courses(id) ON DELETE SET NULL,
    application_id      UUID REFERENCES applications(id) ON DELETE SET NULL,
    payment_type        TEXT NOT NULL CHECK (payment_type IN
                        ('ACTIVATION_FEE','COURSE_PAYMENT','REFUND')),
    amount              NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    currency            TEXT NOT NULL DEFAULT 'USD',
    payment_method      TEXT CHECK (payment_method IN
                        ('mpesa','card','bank','paypal','internal')),
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN
                        ('pending','completed','failed','refunded')),
    external_reference  TEXT,
    price_at_purchase   NUMERIC(10,2),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    verified_at         TIMESTAMPTZ,
    verified_by         UUID REFERENCES users(id)
);

CREATE INDEX idx_transactions_user ON transactions(user_id);
CREATE INDEX idx_transactions_course ON transactions(course_id);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_type ON transactions(payment_type);

CREATE TABLE wallet_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_tx_id    TEXT UNIQUE NOT NULL,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_id  UUID REFERENCES transactions(id) ON DELETE SET NULL,
    type            TEXT NOT NULL CHECK (type IN ('credit','debit')),
    amount          NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','completed','failed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wallet_user ON wallet_transactions(user_id);

-- ============================================================
-- CERTIFICATES
-- ============================================================

CREATE TABLE certificates (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    certificate_id      TEXT UNIQUE NOT NULL,
    verification_token  TEXT UNIQUE NOT NULL,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id           UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    student_name        TEXT NOT NULL,
    course_name         TEXT NOT NULL,
    course_duration     TEXT,
    grade               TEXT,
    issued_date         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    issued_by           UUID REFERENCES users(id),
    revoked             BOOLEAN NOT NULL DEFAULT FALSE,
    revoked_at          TIMESTAMPTZ,
    revoke_reason       TEXT,
    UNIQUE (user_id, course_id)
);

CREATE INDEX idx_certificates_user ON certificates(user_id);
CREATE INDEX idx_certificates_course ON certificates(course_id);

-- ============================================================
-- SPONSORSHIPS
-- ============================================================

CREATE TABLE sponsorships (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sponsor_name    TEXT,
    sponsorship_type TEXT NOT NULL CHECK (sponsorship_type IN
                     ('none','partial','full')),
    amount          NUMERIC(10,2) NOT NULL DEFAULT 0,
    percentage      INTEGER NOT NULL DEFAULT 0
                    CHECK (percentage BETWEEN 0 AND 100),
    covered_courses UUID[],
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sponsorships_user ON sponsorships(user_id);

-- ============================================================
-- ACTIVITY LOG
-- ============================================================

CREATE TABLE activities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    activity_type   TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    metadata        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_activities_user ON activities(user_id);
CREATE INDEX idx_activities_created ON activities(created_at DESC);

-- ============================================================
-- TRIGGERS
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_student_profiles_updated BEFORE UPDATE ON student_profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_applications_updated BEFORE UPDATE ON applications
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_courses_updated BEFORE UPDATE ON courses
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_course_discounts_updated BEFORE UPDATE ON course_discounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_lessons_updated BEFORE UPDATE ON lessons
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_sponsorships_updated BEFORE UPDATE ON sponsorships
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
