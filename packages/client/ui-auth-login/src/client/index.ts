/**
 * Login gate client plugin. On boot, checks `/api/auth/me`. When the server
 * responds 401 (no auth plugin composed, or session expired), the gate is a
 * no-op — the normal DSH boot continues. When the server responds 200 the
 * user is authenticated and boot continues. When it responds 401 from an
 * auth-enabled deployment, this plugin renders a premium login overlay
 * directly into the DOM and blocks the normal boot until login succeeds.
 *
 * The overlay is pure DOM/CSS — it renders before the slot system exists and
 * self-removes after a successful login + page reload.
 *
 * @module @deepseek-ai/dsh-client-ui-auth-login/client
 */

/** The auth-me endpoint the gate probes at boot. */
const AUTH_ME_URL = '/api/auth/me'
/** The login endpoint the form posts to. */
const AUTH_LOGIN_URL = '/api/auth/login'

/** Auth probe result. */
type AuthState =
  | { authenticated: true }
  | { authenticated: false; authEnabled: true }
  | { authenticated: false; authEnabled: false }

/** Shape of a failed-login response body (`{ error: string }`). */
interface LoginErrorResponse {
  error?: string
}

/**
 * Probe the server's auth state. A 200 means the user has a valid session.
 * A 401 from an auth-enabled deployment means the login overlay should show.
 * Any other response (including network failure) means no auth is composed,
 * so the gate steps aside and lets the normal boot proceed.
 * @returns the resolved auth state.
 */
async function probeAuth(): Promise<AuthState> {
  try {
    const response = await fetch(AUTH_ME_URL, { credentials: 'include' })
    if (response.ok) return { authenticated: true }
    if (response.status === 401) return { authenticated: false, authEnabled: true }
    return { authenticated: false, authEnabled: false }
  } catch {
    return { authenticated: false, authEnabled: false }
  }
}

/**
 * Inject the login overlay's CSS into the document head. The styles use the
 * Ethereal Glass archetype: OLED-black background with a subtle radial mesh,
 * a double-bezel glass card, and restrained spring-physics motion. All colors
 * are hardcoded (no design tokens) because this renders before the theme
 * plugin's tokens exist.
 */
function injectStyles(): HTMLStyleElement {
  const style = document.createElement('style')
  style.setAttribute('data-dsh-auth-login', '')
  style.textContent = `
.dsh-auth-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #050505;
  overflow: hidden;
}
.dsh-auth-overlay::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse 80% 60% at 30% 20%, rgba(99, 102, 241, 0.08), transparent 60%),
    radial-gradient(ellipse 60% 50% at 70% 80%, rgba(16, 185, 129, 0.06), transparent 60%);
  pointer-events: none;
}
.dsh-auth-card-shell {
  position: relative;
  padding: 6px;
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5), inset 0 1px 1px rgba(255, 255, 255, 0.06);
  backdrop-filter: blur(40px) saturate(180%);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  animation: dsh-auth-enter 700ms cubic-bezier(0.32, 0.72, 0, 1) both;
  width: 100%;
  max-width: 400px;
  margin: 0 16px;
}
.dsh-auth-card {
  border-radius: 22px;
  background: rgba(10, 10, 12, 0.6);
  padding: 40px 36px 36px;
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.04);
}
.dsh-auth-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 32px;
}
.dsh-auth-logo {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: linear-gradient(135deg, #6366f1, #10b981);
  flex-shrink: 0;
}
.dsh-auth-wordmark {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: rgba(255, 255, 255, 0.9);
}
.dsh-auth-title {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: #fff;
  margin: 0 0 6px;
  line-height: 1.2;
}
.dsh-auth-subtitle {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-size: 14px;
  color: rgba(255, 255, 255, 0.45);
  margin: 0 0 28px;
  line-height: 1.5;
}
.dsh-auth-field {
  margin-bottom: 16px;
}
.dsh-auth-label {
  display: block;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-size: 13px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.55);
  margin-bottom: 6px;
  letter-spacing: -0.005em;
}
.dsh-auth-input {
  width: 100%;
  height: 44px;
  padding: 0 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #fff;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-size: 15px;
  outline: none;
  transition: border-color 200ms cubic-bezier(0.32, 0.72, 0, 1),
              background-color 200ms cubic-bezier(0.32, 0.72, 0, 1);
  box-sizing: border-box;
}
.dsh-auth-input::placeholder {
  color: rgba(255, 255, 255, 0.25);
}
.dsh-auth-input:focus {
  border-color: rgba(99, 102, 241, 0.5);
  background: rgba(99, 102, 241, 0.04);
}
.dsh-auth-input[type="password"] {
  letter-spacing: 0.1em;
}
.dsh-auth-error {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-size: 13px;
  color: #f87171;
  margin: 0 0 16px;
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(248, 113, 113, 0.08);
  border: 1px solid rgba(248, 113, 113, 0.15);
  animation: dsh-auth-enter 300ms cubic-bezier(0.32, 0.72, 0, 1) both;
  line-height: 1.4;
}
.dsh-auth-submit {
  width: 100%;
  height: 48px;
  border: none;
  border-radius: 14px;
  background: linear-gradient(135deg, #6366f1, #4f46e5);
  color: #fff;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.005em;
  cursor: pointer;
  transition: transform 200ms cubic-bezier(0.32, 0.72, 0, 1),
              opacity 200ms cubic-bezier(0.32, 0.72, 0, 1);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 4px;
}
.dsh-auth-submit:hover {
  transform: translateY(-1px);
}
.dsh-auth-submit:active {
  transform: translateY(0) scale(0.98);
}
.dsh-auth-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}
.dsh-auth-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-top-color: #fff;
  border-radius: 50%;
  animation: dsh-auth-spin 600ms linear infinite;
}
@keyframes dsh-auth-enter {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes dsh-auth-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-auth-card-shell,
  .dsh-auth-error,
  .dsh-auth-submit,
  .dsh-auth-input {
    animation: none;
    transition: none;
  }
}
`
  document.head.appendChild(style)
  return style
}

/**
 * Build the login overlay DOM tree. Returns the root element (not yet
 * attached) plus a handle to the interactive elements the caller wires up.
 */
function buildOverlay(): {
  root: HTMLDivElement
  form: HTMLFormElement
  idInput: HTMLInputElement
  passwordInput: HTMLInputElement
  errorBox: HTMLDivElement
  submitButton: HTMLButtonElement
} {
  injectStyles()

  const root = document.createElement('div')
  root.className = 'dsh-auth-overlay'

  const shell = document.createElement('div')
  shell.className = 'dsh-auth-card-shell'
  root.appendChild(shell)

  const card = document.createElement('div')
  card.className = 'dsh-auth-card'
  shell.appendChild(card)

  // Brand row
  const brand = document.createElement('div')
  brand.className = 'dsh-auth-brand'
  const logo = document.createElement('div')
  logo.className = 'dsh-auth-logo'
  const wordmark = document.createElement('span')
  wordmark.className = 'dsh-auth-wordmark'
  wordmark.textContent = 'DeepSeek Harness'
  brand.appendChild(logo)
  brand.appendChild(wordmark)
  card.appendChild(brand)

  // Title
  const title = document.createElement('h1')
  title.className = 'dsh-auth-title'
  title.textContent = 'Masuk'
  card.appendChild(title)

  const subtitle = document.createElement('p')
  subtitle.className = 'dsh-auth-subtitle'
  subtitle.textContent = 'Masukkan kredensial Anda untuk mengakses workspace.'
  card.appendChild(subtitle)

  // Error box (hidden initially)
  const errorBox = document.createElement('div')
  errorBox.className = 'dsh-auth-error'
  errorBox.style.display = 'none'
  card.appendChild(errorBox)

  // Form
  const form = document.createElement('form')
  card.appendChild(form)

  // ID field
  const idField = document.createElement('div')
  idField.className = 'dsh-auth-field'
  const idLabel = document.createElement('label')
  idLabel.className = 'dsh-auth-label'
  idLabel.htmlFor = 'dsh-auth-id'
  idLabel.textContent = 'User ID'
  const idInput = document.createElement('input')
  idInput.className = 'dsh-auth-input'
  idInput.type = 'text'
  idInput.id = 'dsh-auth-id'
  idInput.name = 'id'
  idInput.autocomplete = 'username'
  idInput.placeholder = 'user id'
  idInput.required = true
  idField.appendChild(idLabel)
  idField.appendChild(idInput)
  form.appendChild(idField)

  // Password field
  const pwField = document.createElement('div')
  pwField.className = 'dsh-auth-field'
  const pwLabel = document.createElement('label')
  pwLabel.className = 'dsh-auth-label'
  pwLabel.htmlFor = 'dsh-auth-password'
  pwLabel.textContent = 'Password'
  const passwordInput = document.createElement('input')
  passwordInput.className = 'dsh-auth-input'
  passwordInput.type = 'password'
  passwordInput.id = 'dsh-auth-password'
  passwordInput.name = 'password'
  passwordInput.autocomplete = 'current-password'
  passwordInput.placeholder = 'password'
  passwordInput.required = true
  pwField.appendChild(pwLabel)
  pwField.appendChild(passwordInput)
  form.appendChild(pwField)

  // Submit button
  const submitButton = document.createElement('button')
  submitButton.className = 'dsh-auth-submit'
  submitButton.type = 'submit'
  submitButton.textContent = 'Masuk'
  form.appendChild(submitButton)

  return { root, form, idInput, passwordInput, errorBox, submitButton }
}

/**
 * Handle a login form submission: POST credentials and reflect the outcome in
 * the error box / submit button. On success, reload so the boot chain
 * re-probes `/api/auth/me` and finds the new session cookie.
 * @param id - the user id from the input.
 * @param password - the password from the input.
 * @param errorBox - the error message element to show on failure.
 * @param submitButton - the submit button to disable/spin while in flight.
 */
async function handleSubmit(
  id: string,
  password: string,
  errorBox: HTMLDivElement,
  submitButton: HTMLButtonElement,
): Promise<void> {
  errorBox.style.display = 'none'
  submitButton.disabled = true
  submitButton.innerHTML = '<span class="dsh-auth-spinner"></span> Masuk...'

  try {
    const response = await fetch(AUTH_LOGIN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ id, password }),
    })

    if (response.ok) {
      // Login succeeded — reload to re-enter the boot chain with a session cookie.
      window.location.reload()
      return
    }

    const data = await response.json().catch(() => ({})) as LoginErrorResponse
    errorBox.textContent = typeof data.error === 'string' && data.error.length > 0
      ? data.error
      : 'Login gagal. Periksa user ID dan password Anda.'
    errorBox.style.display = 'block'
  } catch {
    errorBox.textContent = 'Tidak dapat terhubung ke server. Coba lagi.'
    errorBox.style.display = 'block'
  } finally {
    submitButton.disabled = false
    submitButton.textContent = 'Masuk'
  }
}

/**
 * Show the login overlay. On successful login, reloads the page so the boot
 * chain re-probes `/api/auth/me` and finds the new session cookie.
 */
function showLoginOverlay(): void {
  const { root, form, idInput, passwordInput, errorBox, submitButton } = buildOverlay()
  document.body.appendChild(root)
  idInput.focus()

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void handleSubmit(idInput.value, passwordInput.value, errorBox, submitButton)
  })
}

/**
 * Client plugin body: probe auth at boot and gate the UI when auth is enabled.
 * When no auth plugin is composed, the probe resolves `authEnabled: false` and
 * this plugin is a silent no-op. The context is accepted to satisfy the Cordis
 * plugin signature but the gate runs before any service injection is needed.
 */
export function apply(): void {
  void (async () => {
    const state = await probeAuth()
    if (state.authenticated || !state.authEnabled) return
    showLoginOverlay()
  })()
}
