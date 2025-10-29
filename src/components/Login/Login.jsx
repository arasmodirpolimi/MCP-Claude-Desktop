import { useState } from "react";
import styles from "./Login.module.css";
import { useAuth } from "../../context/AuthContext";

// Simple email regex for basic validation (not exhaustive)
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function Login({ onLogin }) {
  const { signInWithEmail, error: authError } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function validate() {
    if (!EMAIL_REGEX.test(email)) {
      return "Please enter a valid email address.";
    }
    if (password.length < 6) {
      return "Password must be at least 6 characters.";
    }
    return null;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      const { error } = await signInWithEmail(email, password);
      if (error) {
        setError(error.message || "Login failed. Please check your credentials.");
      } else {
        if (remember) {
          try { localStorage.setItem("auth_email", email); } catch {}
        }
        // Navigate to chat section on successful login
        onLogin(true);
      }
    } catch (err) {
      setError(err.message || "Unexpected error. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className={styles.Background}>
      <div className={styles.Noise} />
      <div className={styles.OrbA} />
      <div className={styles.OrbB} />
      <form onSubmit={handleSubmit} className={styles.Card} aria-labelledby="loginTitle">
        <h1 id="loginTitle" className={styles.Title}>Welcome Back</h1>
        <p className={styles.Subtitle}>Sign in to start chatting with AI</p>
        {(error || authError) && (
          <div role="alert" className={styles.Error}>
            {error || authError}
          </div>
        )}
        <label className={styles.Label}>
          <span>Email</span>
          <input
            type="email"
            autoComplete="email"
            className={styles.Input}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
          />
        </label>
        <label className={styles.Label}>
          <span>Password</span>
          <div className={styles.PasswordWrapper}>
            <input
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              className={styles.Input}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
            />
            <button
              type="button"
              className={styles.Toggle}
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </label>
        <div className={styles.Row}>
          <label className={styles.CheckLabel}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>Remember me</span>
          </label>
          <button
            type="button"
            className={styles.LinkButton}
            onClick={() => alert("Password reset flow coming soon.")}
          >
            Forgot password?
          </button>
        </div>
        <button
          type="submit"
          className={styles.Submit}
          disabled={isSubmitting}
        >
          {isSubmitting ? <span className={styles.Spinner} /> : "Sign In"}
        </button>
        {/* <div className={styles.Divider}>
          <span>or continue with</span>
        </div> */}
        {/* <div className={styles.SocialRow}>
          <button type="button" className={styles.SocialBtn} onClick={() => alert("Google login soon")}>Google</button>
          <button type="button" className={styles.SocialBtn} onClick={() => alert("GitHub login soon")}>GitHub</button>
        </div> */}
        <p className={styles.FinePrint}>By signing in you agree to our Terms & Privacy Policy.</p>
      </form>
    </div>
  );
}

export default Login;
