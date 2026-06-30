/**
 * AboutSection — version, update check, project links, and social media.
 */
import type { ReactElement, SVGProps } from 'react';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { useUpdateCheck } from '@/hooks/useUpdateCheck';
import { getInstallGuideUrl } from '@/lib/site-links';

type SocialKey = 'github';

interface SocialLink {
  key: SocialKey;
  href: string;
  color: string;
  Icon: (props: SVGProps<SVGSVGElement>) => ReactElement;
}

const SOCIAL_LINKS: SocialLink[] = [
  {
    key: 'github',
    href: 'https://github.com/LinYanZhi/Cebian',
    color: 'currentColor',
    Icon: GitHubIcon,
  },
];

const INSTALL_GUIDE_URL = getInstallGuideUrl();

export function AboutSection() {
  const { status, current, recheck } = useUpdateCheck();

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.about.title')}</h2>

      <div className="space-y-1">
        <p className="text-sm font-medium">Cebian v{current}</p>
        <p className="text-xs text-muted-foreground">{t('settings.about.tagline')}</p>
        <div className="flex gap-2 pt-2 text-xs text-muted-foreground">
          <a
            href="https://github.com/LinYanZhi/Cebian"
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-foreground transition-colors"
          >
            GitHub
          </a>
          <span>·</span>
          <a
            href="https://github.com/maotoumao/Cebian"
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-foreground transition-colors"
          >
            {t('settings.about.originalAuthor')}
          </a>
          <span>·</span>
          <a
            href="https://github.com/LinYanZhi/Cebian/blob/HEAD/LICENSE"
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-foreground transition-colors"
          >
            AGPL-3.0
          </a>
          <span>·</span>
          <a
            href="https://github.com/LinYanZhi/Cebian/issues"
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-foreground transition-colors"
          >
            {t('settings.about.feedback')}
          </a>
        </div>
      </div>

      <UpdateCheckRow status={status} onRecheck={recheck} />

      <FollowAuthorSection />
    </div>
  );
}

function FollowAuthorSection() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <p className="text-sm font-medium">{t('settings.about.followAuthor')}</p>
        <div className="h-px flex-1 bg-linear-to-r from-border to-transparent" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {SOCIAL_LINKS.map((link) => (
          <SocialCard key={link.key} link={link} />
        ))}
      </div>
    </div>
  );
}

function SocialCard({ link }: { link: SocialLink }) {
  const { Icon, color, key, href } = link;
  const label = t(`settings.about.socials.${key}` as `settings.about.socials.${SocialKey}`);
  const subtitle = t(
    `settings.about.socials.${key}Handle` as `settings.about.socials.${SocialKey}Handle`,
  );

  const cardClass = `
    group relative flex items-center gap-3 rounded-lg border border-border bg-card/50 px-4 py-3
    transition-all duration-200
  `;
  const hoverClass = `
    hover:-translate-y-0.5 hover:border-[var(--social-color)] hover:shadow-sm
    hover:bg-[color-mix(in_oklab,var(--social-color)_6%,transparent)]
  `;
  const style = { ['--social-color' as string]: color } as React.CSSProperties;

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      style={style}
      className={`${cardClass} ${hoverClass}`}
    >
      <span
        className="
          flex h-10 w-10 shrink-0 items-center justify-center rounded-md
          bg-[color-mix(in_oklab,var(--social-color)_12%,transparent)]
          text-(--social-color)
          transition-transform duration-200 group-hover:scale-105
        "
        aria-hidden="true"
      >
        <Icon width={20} height={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
      </span>
    </a>
  );
}

interface UpdateCheckRowProps {
  status: ReturnType<typeof useUpdateCheck>['status'];
  onRecheck: () => void;
}

function UpdateCheckRow({ status, onRecheck }: UpdateCheckRowProps) {
  const isBusy = status.kind === 'checking';

  let statusNode: React.ReactNode = null;
  if (status.kind === 'checking') {
    statusNode = <span className="text-xs text-muted-foreground">{t('settings.about.checking')}</span>;
  } else if (status.kind === 'upToDate') {
    statusNode = <span className="text-xs text-muted-foreground">{t('settings.about.upToDate')}</span>;
  } else if (status.kind === 'error') {
    statusNode = <span className="text-xs text-destructive">{t('settings.about.checkFailed')}</span>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={onRecheck} disabled={isBusy} aria-busy={isBusy}>
          {t('settings.about.checkUpdate')}
        </Button>
        <span role="status" aria-live="polite">
          {statusNode}
        </span>
      </div>
      {status.kind === 'updateAvailable' && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-border bg-accent/40 p-3 space-y-2"
        >
          <p className="text-xs">{t('settings.about.updateAvailable', [status.latest])}</p>
          <Button asChild size="sm">
            <a href={INSTALL_GUIDE_URL} target="_blank" rel="noreferrer noopener">
              {t('settings.about.viewInstallGuide')}
            </a>
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Brand icons (inline SVG) ───

function GitHubIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
    </svg>
  );
}
