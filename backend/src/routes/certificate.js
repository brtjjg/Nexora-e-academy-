/* ═══════════════════════════════════════════════════════════
   NEXORA ACADEMY — CERTIFICATE RENDERER
   ═══════════════════════════════════════════════════════════ */
const API_BASE = 'https://nexora-api-sskg.onrender.com/api';

/* Escape HTML */
function certEsc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function certFmtDate(d){
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-GB',{ day:'2-digit', month:'long', year:'numeric' });
}

/* Draw QR code as data URL using a lightweight approach (via api.qrserver.com) */
function certQrUrl(text){
  return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=0&data=${encodeURIComponent(text)}`;
}

/* Fetch certificate by ID via public verify endpoint */
async function certFetch(certId){
  const res = await fetch(`${API_BASE}/certificates/verify/${encodeURIComponent(certId)}`);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.valid) throw new Error((data && data.error) || 'Certificate not found');
  return data.certificate;
}

/* Build the HTML for a certificate */
function certRenderHTML(cert){
  const verifyUrl = `https://nexora-e-academy.vercel.app/certificate.html?id=${encodeURIComponent(cert.certificate_id)}`;

  return `
  <div class="certificate" id="certificateNode">
    <!-- Decorative corners -->
    <div class="cert-corner-tl"></div>
    <div class="cert-corner-br"></div>

    <!-- Gold borders -->
    <div class="cert-border-outer"></div>
    <div class="cert-border-inner"></div>

    <!-- Seal top-left -->
    <div class="cert-seal-topleft">
      <div class="seal-ribbon"></div>
      <div class="seal-coin">
        <div class="seal-inner">
          <i class="fas fa-graduation-cap"></i>
          <div class="txt">EXCELLENCE</div>
        </div>
      </div>
    </div>

    <div class="cert-content">
      <!-- Header -->
      <div class="cert-header">
        <div class="cert-logo-wrap">
          <div class="cert-logo-badge">
            <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
              <!-- Book with play button -->
              <path d="M20 30 L50 20 L80 30 L80 72 L50 62 L20 72 Z"
                    fill="#0B1F3A" stroke="#D4A63A" stroke-width="3" stroke-linejoin="round"/>
              <path d="M50 20 L50 62" stroke="#D4A63A" stroke-width="2.5"/>
              <circle cx="50" cy="42" r="11" fill="#D4A63A"/>
              <path d="M46 36 L46 48 L56 42 Z" fill="#0B1F3A"/>
            </svg>
          </div>
          <div class="cert-brand-text">
            <span class="brand-nexora">NEXORA</span>
            <span class="brand-academy">ACADEMY</span>
            <span class="brand-tagline">LEARN • GROW • ACHIEVE</span>
          </div>
        </div>
        <div class="cert-id-block">
          <div class="lbl">Certificate ID</div>
          <div class="val">${certEsc(cert.certificate_id)}</div>
        </div>
      </div>

      <!-- Title -->
      <div class="cert-title-block">
        <h1 class="cert-title">CERTIFICATE</h1>
        <h2 class="cert-subtitle">OF COURSE COMPLETION</h2>
        <div class="cert-title-divider"><span class="diamond"></span></div>
      </div>

      <!-- Presented -->
      <div class="cert-presented">This is to certify that</div>

      <!-- Student name -->
      <div class="cert-student-name">${certEsc(cert.student_name || 'Student')}</div>
      <div class="cert-name-underline"></div>

      <!-- Completion text -->
      <div class="cert-completion-text">
        has successfully completed all the academic and graduation requirements for the course
      </div>

      <!-- Course name -->
      <div class="cert-course-name">${certEsc(cert.course_name || 'Course')}</div>

      <!-- Body: meta | requirements | QR -->
      <div class="cert-body">
        <!-- Left meta -->
        <div class="cert-meta">
          <div class="cert-meta-item">
            <div class="cert-meta-icon"><i class="fas fa-calendar-alt"></i></div>
            <div class="cert-meta-text">
              <div class="cert-meta-label">Course Duration</div>
              <div class="cert-meta-value">${certEsc(cert.course_duration || 'Self-paced')}</div>
            </div>
          </div>
          <div class="cert-meta-item">
            <div class="cert-meta-icon"><i class="fas fa-calendar-check"></i></div>
            <div class="cert-meta-text">
              <div class="cert-meta-label">Date Issued</div>
              <div class="cert-meta-value">${certFmtDate(cert.issued_date)}</div>
            </div>
          </div>
          <div class="cert-meta-item">
            <div class="cert-meta-icon"><i class="fas fa-award"></i></div>
            <div class="cert-meta-text">
              <div class="cert-meta-label">Grade</div>
              <div class="cert-meta-value">${certEsc(cert.grade || 'Competent')}</div>
            </div>
          </div>
          <div class="cert-meta-item">
            <div class="cert-meta-icon"><i class="fas fa-user"></i></div>
            <div class="cert-meta-text">
              <div class="cert-meta-label">Student ID</div>
              <div class="cert-meta-value">${certEsc(cert.student_id || '—')}</div>
            </div>
          </div>
        </div>

        <!-- Center requirements -->
        <div class="cert-requirements">
          <div class="cert-req-item"><span class="cert-req-check"><i class="fas fa-check"></i></span> Completed 100% of the course content</div>
          <div class="cert-req-item"><span class="cert-req-check"><i class="fas fa-check"></i></span> Met the required attendance</div>
          <div class="cert-req-item"><span class="cert-req-check"><i class="fas fa-check"></i></span> Completed all assignments</div>
          <div class="cert-req-item"><span class="cert-req-check"><i class="fas fa-check"></i></span> Completed all individual projects</div>
          <div class="cert-req-item"><span class="cert-req-check"><i class="fas fa-check"></i></span> Passed all required assessments</div>
          <div class="cert-req-item"><span class="cert-req-check"><i class="fas fa-check"></i></span> Satisfied all graduation requirements</div>
          <div class="cert-req-item"><span class="cert-req-check"><i class="fas fa-check"></i></span> Completed full course payment</div>
        </div>

        <!-- Right QR -->
        <div class="cert-qr-block">
          <div class="cert-qr-label">Verify Certificate</div>
          <div class="cert-qr-box">
            <img src="${certQrUrl(verifyUrl)}" alt="QR code to verify certificate">
          </div>
          <div class="cert-qr-caption">
            Scan QR Code to Verify<br>or visit:
          </div>
          <div class="cert-qr-url">nexoraacademy.com/verify</div>
        </div>
      </div>

      <!-- Closing -->
      <div class="cert-closing">
        In recognition of your dedication, hard work, and successful completion of
        all requirements, this certificate is proudly awarded to you.
      </div>

      <!-- Signatures -->
      <div class="cert-signatures">
        <div class="cert-sig">
          <div class="cert-sig-script">Dr. Kelvin M. Ochieng</div>
          <div class="cert-sig-line"></div>
          <div class="cert-sig-name">Academic Director</div>
        </div>
        <div class="cert-official-seal">
          <div class="cert-official-seal-inner">
            <div class="s-logo"><i class="fas fa-graduation-cap"></i></div>
            <div class="s-text">NEXORA<br>ACADEMY</div>
            <div class="s-ribbon">OFFICIAL SEAL</div>
          </div>
        </div>
        <div class="cert-sig">
          <div class="cert-sig-script">Jane A. Wambui</div>
          <div class="cert-sig-line"></div>
          <div class="cert-sig-name">Registrar</div>
        </div>
      </div>

      <!-- Footer note -->
      <div class="cert-footer-note">
        This certificate is issued electronically and is valid without a signature.
      </div>
    </div>
  </div>`;
}

/* Render a certificate into a container */
async function certRender(certId, container){
  container.innerHTML = '<div class="cert-loading"><i class="fas fa-spinner fa-spin"></i> Loading certificate...</div>';
  try {
    const cert = await certFetch(certId);
    container.innerHTML = `
      ${certRenderHTML(cert)}
      <div class="cert-toolbar" style="margin-top:24px">
        <button class="cert-btn cert-btn-primary" onclick="window.print()">
          <i class="fas fa-download"></i> Download / Print
        </button>
        <button class="cert-btn cert-btn-outline" onclick="navigator.clipboard.writeText('${certEsc(cert.certificate_id)}').then(()=>alert('Certificate ID copied!'))">
          <i class="fas fa-copy"></i> Copy ID
        </button>
      </div>`;
  } catch (err){
    container.innerHTML = `
      <div class="cert-error">
        <i class="fas fa-exclamation-triangle"></i>
        <h2>Certificate not found</h2>
        <p>${certEsc(err.message || 'The certificate ID is invalid or has been revoked.')}</p>
        <a href="/" class="cert-btn cert-btn-primary">Go to Nexora Academy</a>
      </div>`;
  }
}

/* Open certificate in a modal (used from index.html) */
async function openCertificateModal(certId){
  let modal = document.getElementById('certificateModal');
  if (!modal){
    modal = document.createElement('div');
    modal.id = 'certificateModal';
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:1100px;padding:20px">
        <button onclick="closeCertificateModal()"
                style="position:absolute;top:12px;right:16px;background:transparent;border:none;font-size:1.6rem;cursor:pointer;color:#64748B">&times;</button>
        <div id="certificateModalBody"></div>
      </div>`;
    document.body.appendChild(modal);
  }
  modal.classList.add('active');
  await certRender(certId, document.getElementById('certificateModalBody'));
}

function closeCertificateModal(){
  const modal = document.getElementById('certificateModal');
  if (modal) modal.classList.remove('active');
}

/* Auto-run on standalone certificate.html page */
document.addEventListener('DOMContentLoaded', () => {
  const mount = document.getElementById('certRender');
  if (!mount) return;
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  if (!id){
    document.getElementById('certLoading')?.classList.add('hidden');
    document.getElementById('certError')?.classList.remove('hidden');
    return;
  }
  document.getElementById('certLoading')?.classList.add('hidden');
  certRender(id, mount);
});

window.openCertificateModal = openCertificateModal;
window.closeCertificateModal = closeCertificateModal;
window.certRender = certRender;
