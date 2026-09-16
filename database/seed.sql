-- ============================================================
-- NEXORA ACADEMY — SEED DATA
-- Default passwords:
--   admin@nexora.com  → admin123
--   brian@nexora.com  → student123
-- CHANGE THESE IMMEDIATELY AFTER FIRST LOGIN IN PRODUCTION
-- ============================================================

INSERT INTO users (username, email, password_hash, full_name, role, status)
VALUES (
    'admin',
    'admin@nexora.com',
    '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
    'Administrator',
    'admin',
    'active'
)
ON CONFLICT (email) DO NOTHING;

INSERT INTO users (username, email, password_hash, full_name, phone, country, role, status)
VALUES (
    'brian',
    'brian@nexora.com',
    '$2b$10$8K1p/a0dL1LXMIgoEDFrwOfgqwAGqXvUKFR0Dp6ZJd7RqXcJqHqLu',
    'Brian Ondieki',
    '+254700000000',
    'Kenya',
    'student',
    'active'
)
ON CONFLICT (email) DO NOTHING;

INSERT INTO student_profiles (
    user_id, admission_number, course_interest,
    activation_fee_paid, admission_status, approval_status, approved_at
)
SELECT id, 'NXA-ADM-2026-000001', 'Computer Packages',
       TRUE, 'approved', 'approved', NOW()
FROM users WHERE email = 'brian@nexora.com'
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO courses (
    title, code, category, level, description,
    instructor_name, duration, price, status
)
VALUES (
    'Computer Packages',
    'NXA-CP-101',
    'IT & Technology',
    'Beginner',
    'Complete training in MS Office, typing, and basic computing.',
    'Dr. Kelvin M. Obieing',
    '3 Months',
    20.00,
    'published'
)
ON CONFLICT (code) DO NOTHING;

INSERT INTO modules (course_id, title, position)
SELECT id, 'Introduction', 1 FROM courses WHERE code = 'NXA-CP-101';

INSERT INTO lessons (module_id, title, description, position, notes, assignment, published)
SELECT m.id, 'What is a Computer?', 'Welcome to the course.', 1,
       'A computer is an electronic device that processes data.',
       'List 3 types of computers you know.', TRUE
FROM modules m
JOIN courses c ON c.id = m.course_id
WHERE c.code = 'NXA-CP-101' AND m.position = 1;

INSERT INTO questions (course_id, question_type, question_text, options, correct_index, marks, position)
SELECT id, 'exam', 'What is MS Word?',
       '["Word processor","Web browser","Operating system","Database"]'::jsonb,
       0, 2, 1
FROM courses WHERE code = 'NXA-CP-101';

INSERT INTO questions (course_id, question_type, question_text, options, correct_index, marks, position)
SELECT id, 'cat', 'What is a computer?',
       '["Electronic device","Animal","Plant","Mineral"]'::jsonb,
       0, 5, 1
FROM courses WHERE code = 'NXA-CP-101';

INSERT INTO admission_counters (year, counter)
VALUES (EXTRACT(YEAR FROM NOW())::INTEGER, 1)
ON CONFLICT (year) DO UPDATE SET counter = GREATEST(admission_counters.counter, 1);
