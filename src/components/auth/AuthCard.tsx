"use client";

import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";

type AuthView = "login" | "register";

type FieldErrors = Record<string, string>;

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function passwordStrength(password: string): "weak" | "medium" | "strong" | null {
  if (!password) return null;
  let score = 0;
  if (password.length >= 8) score += 1;
  if (/[A-Za-z]/.test(password) && /\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  if (password.length >= 12) score += 1;
  if (score <= 1) return "weak";
  if (score === 2) return "medium";
  return "strong";
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  error,
  onBlur,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  onBlur: () => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1.5 block text-[13px] text-[#374151]">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
          className={`h-10 w-full rounded-lg border bg-white px-3 pr-10 text-sm text-[#1F2328] outline-none transition focus:shadow-[0_0_0_3px_rgba(208,215,222,0.45)] ${
            error ? "border-[#FECACA]" : "border-[#D0D7DE]"
          }`}
        />
        <button
          type="button"
          aria-label={visible ? "隐藏密码" : "显示密码"}
          className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-[#8C9198] hover:bg-[#F6F8FA]"
          onClick={() => setVisible((prev) => !prev)}
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-[#B42318]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function AuthCard() {
  const router = useRouter();
  const [view, setView] = useState<AuthView>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [bannerError, setBannerError] = useState("");
  const [loading, setLoading] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const strength = useMemo(() => passwordStrength(password), [password]);

  function validateLogin() {
    const errors: FieldErrors = {};
    if (!isValidEmail(email.trim())) errors.email = "请输入有效邮箱";
    if (!password) errors.password = "请输入密码";
    return errors;
  }

  function isValidInviteCode(code: string) {
    const normalized = code.trim().toUpperCase();
    return /^[A-Z0-9]{8}$/.test(normalized) && /[A-Z]/.test(normalized) && /[0-9]/.test(normalized);
  }

  function validateRegister() {
    const errors: FieldErrors = {};
    if (!isValidInviteCode(inviteCode)) errors.inviteCode = "请输入 8 位字母与数字组合的邀请码";
    if (!isValidEmail(email.trim())) errors.email = "请输入有效邮箱";
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      errors.password = "密码至少 8 位且包含字母和数字";
    }
    if (password !== confirmPassword) errors.confirmPassword = "两次输入的密码不一致";
    if (displayName.trim().length > 30) errors.displayName = "昵称不能超过 30 字";
    return errors;
  }

  function markTouched(key: string) {
    setTouched((prev) => ({ ...prev, [key]: true }));
    const errors = view === "login" ? validateLogin() : validateRegister();
    setFieldErrors(errors);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBannerError("");
    const errors = view === "login" ? validateLogin() : validateRegister();
    setFieldErrors(errors);
    setTouched({
      email: true,
      password: true,
      confirmPassword: true,
      displayName: true,
      inviteCode: view === "register",
    });
    if (Object.keys(errors).length > 0) return;

    setLoading(true);
    try {
      const endpoint = view === "login" ? "/api/auth/login" : "/api/auth/register";
      const payload =
        view === "login"
          ? { email, password }
          : {
              email,
              password,
              confirmPassword,
              displayName: displayName.trim() || undefined,
              inviteCode: inviteCode.trim().toUpperCase(),
            };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        reason?: string;
        field?: string;
      };
      if (!response.ok || !data.ok) {
        if (view === "register" && (data.field === "email" || data.field === "inviteCode")) {
          setFieldErrors((prev) => ({
            ...prev,
            [data.field!]: data.reason || (data.field === "email" ? "该邮箱已被注册" : "邀请码无效"),
          }));
          return;
        }
        setBannerError(data.reason || (view === "login" ? "邮箱或密码不正确" : "注册失败"));
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setBannerError("网络异常，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  function switchView(next: AuthView) {
    setView(next);
    setBannerError("");
    setFieldErrors({});
    setTouched({});
    if (next === "login") setInviteCode("");
  }

  return (
    <div className="w-full max-w-[400px] rounded-2xl border border-[#E5E7EB] bg-white px-7 py-8 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_4px_16px_rgba(16,24,40,0.04)]">
      <h1 className="text-xl font-semibold tracking-tight text-[#1F2328]">
        {view === "login" ? "账号登录" : "创建账号"}
      </h1>
      <p className="mt-1.5 text-[13px] text-[#6B7280]">
        {view === "login" ? "登录以进入你的工作空间" : "需要有效邀请码方可注册独立工作空间"}
      </p>

      {bannerError ? (
        <div className="mt-4 rounded-lg bg-[#FEF2F2] px-3 py-2 text-sm text-[#B42318]">{bannerError}</div>
      ) : null}

      <form className="mt-5" onSubmit={handleSubmit}>
        {view === "register" ? (
          <div className="mb-4">
            <label htmlFor="inviteCode" className="mb-1.5 block text-[13px] text-[#374151]">
              邀请码
            </label>
            <input
              id="inviteCode"
              type="text"
              autoComplete="off"
              spellCheck={false}
              maxLength={8}
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
              onBlur={() => markTouched("inviteCode")}
              placeholder="8 位字母与数字"
              aria-invalid={Boolean(touched.inviteCode && fieldErrors.inviteCode)}
              aria-describedby={fieldErrors.inviteCode ? "inviteCode-error" : undefined}
              className={`h-10 w-full rounded-lg border bg-white px-3 font-mono text-sm tracking-widest outline-none transition focus:shadow-[0_0_0_3px_rgba(208,215,222,0.45)] ${
                touched.inviteCode && fieldErrors.inviteCode ? "border-[#FECACA]" : "border-[#D0D7DE]"
              }`}
            />
            {touched.inviteCode && fieldErrors.inviteCode ? (
              <p id="inviteCode-error" className="mt-1.5 text-xs text-[#B42318]">
                {fieldErrors.inviteCode}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="mb-4">
          <label htmlFor="email" className="mb-1.5 block text-[13px] text-[#374151]">
            邮箱
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onBlur={() => markTouched("email")}
            aria-invalid={Boolean(touched.email && fieldErrors.email)}
            aria-describedby={fieldErrors.email ? "email-error" : undefined}
            className={`h-10 w-full rounded-lg border bg-white px-3 text-sm outline-none transition focus:shadow-[0_0_0_3px_rgba(208,215,222,0.45)] ${
              touched.email && fieldErrors.email ? "border-[#FECACA]" : "border-[#D0D7DE]"
            }`}
          />
          {touched.email && fieldErrors.email ? (
            <p id="email-error" className="mt-1.5 text-xs text-[#B42318]">
              {fieldErrors.email}
            </p>
          ) : null}
        </div>

        <PasswordField
          id="password"
          label="密码"
          value={password}
          onChange={setPassword}
          error={touched.password ? fieldErrors.password : undefined}
          onBlur={() => markTouched("password")}
        />

        {view === "register" && strength ? (
          <div className="mb-4 flex items-center gap-2 text-xs">
            <span className="text-[#6B7280]">密码强度</span>
            <span
              className={
                strength === "weak"
                  ? "text-[#B42318]"
                  : strength === "medium"
                    ? "text-[#8A6D3B]"
                    : "text-[#1A7F37]"
              }
            >
              {strength === "weak" ? "弱" : strength === "medium" ? "中" : "强"}
            </span>
          </div>
        ) : null}

        {view === "register" ? (
          <>
            <PasswordField
              id="confirmPassword"
              label="确认密码"
              value={confirmPassword}
              onChange={setConfirmPassword}
              error={touched.confirmPassword ? fieldErrors.confirmPassword : undefined}
              onBlur={() => markTouched("confirmPassword")}
            />
            <div className="mb-4">
              <div className="mb-1.5 flex items-baseline justify-between">
                <label htmlFor="displayName" className="text-[13px] text-[#374151]">
                  昵称
                </label>
                <span className="text-xs text-[#8C9198]">可选</span>
              </div>
              <input
                id="displayName"
                type="text"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                onBlur={() => markTouched("displayName")}
                className={`h-10 w-full rounded-lg border bg-white px-3 text-sm outline-none ${
                  touched.displayName && fieldErrors.displayName ? "border-[#FECACA]" : "border-[#D0D7DE]"
                }`}
              />
              {touched.displayName && fieldErrors.displayName ? (
                <p className="mt-1.5 text-xs text-[#B42318]">{fieldErrors.displayName}</p>
              ) : null}
            </div>
          </>
        ) : null}

        <button
          type="submit"
          disabled={loading}
          aria-busy={loading}
          className="mt-2 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[#1F2328] text-sm font-medium text-white transition hover:bg-[#374151] disabled:opacity-70"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {loading ? (view === "login" ? "登录中…" : "注册中…") : view === "login" ? "登录" : "创建账号"}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-[#6B7280]">
        {view === "login" ? (
          <>
            还没有账号？{" "}
            <button type="button" className="text-[#1F2328] underline" onClick={() => switchView("register")}>
              创建账号
            </button>
          </>
        ) : (
          <>
            已有账号？{" "}
            <button type="button" className="text-[#1F2328] underline" onClick={() => switchView("login")}>
              去登录
            </button>
          </>
        )}
      </p>
    </div>
  );
}
