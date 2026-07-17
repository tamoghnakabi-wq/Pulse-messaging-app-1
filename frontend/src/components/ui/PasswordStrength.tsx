/** Visual password strength meter + client-side policy hints */

const COMMON = new Set([
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  'qwerty123',
  'iloveyou',
  'admin123',
  'welcome1',
  'letmein',
  'passw0rd',
  'changeme',
  'pulse123',
]);

export function scorePassword(password: string): number {
  if (!password) return 0;
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score++;
  if (COMMON.has(password.toLowerCase())) score = Math.min(score, 1);
  return Math.min(4, score);
}

export function passwordErrors(password: string): string[] {
  const e: string[] = [];
  if (password.length > 0 && password.length < 8) e.push('At least 8 characters');
  if (password.length > 72) e.push('At most 72 characters');
  if (password && !/[A-Za-z]/.test(password)) e.push('Include a letter');
  if (password && !/[0-9]/.test(password)) e.push('Include a number');
  if (COMMON.has(password.toLowerCase())) e.push('Too common — pick something unique');
  return e;
}

const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
const colors = [
  'bg-black/10',
  'bg-red-500',
  'bg-amber-500',
  'bg-pulse-500',
  'bg-emerald-500',
];

export function PasswordStrength({ password }: { password: string }) {
  const score = scorePassword(password);
  const errors = passwordErrors(password);
  if (!password) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex gap-1">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              i <= score ? colors[score] : 'bg-black/10 dark:bg-white/10'
            }`}
          />
        ))}
      </div>
      <p className="text-[11px] font-medium text-[var(--color-ink-secondary)]">
        Strength: {labels[score] || 'Too short'}
      </p>
      {errors.length > 0 && (
        <ul className="text-[11px] text-red-500">
          {errors.map((err) => (
            <li key={err}>{err}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
