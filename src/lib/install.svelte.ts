// Installation sur l'écran d'accueil : sans barre d'adresse, le jeu profite de tout l'écran.
// - Android (Chrome…) : le navigateur propose l'installation via `beforeinstallprompt`, qu'on
//   intercepte dès le chargement pour la déclencher depuis notre bouton.
// - iPhone / iPad : aucune installation par programme ; on montre les gestes à faire dans Safari.
// - Autres navigateurs mobiles (Firefox…) : pas de `beforeinstallprompt` non plus, mais une
//   installation par leur menu ; on l'explique.

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const standalone = (): boolean =>
  typeof window !== 'undefined' &&
  (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || (navigator as { standalone?: boolean }).standalone === true);

// (les iPad récents se présentent comme un Mac : on les reconnaît à l'écran tactile)
const ios = (): boolean =>
  typeof navigator !== 'undefined' && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1));

// écran tactile principal : un téléphone ou une tablette (sur ordinateur, on ne propose rien)
const mobile = (): boolean => typeof window !== 'undefined' && matchMedia('(pointer: coarse)').matches;

class Install {
  /** Le jeu tourne déjà comme une appli installée. */
  installed = $state(standalone());
  /** Android : l'installation peut être lancée depuis l'appli. */
  canPrompt = $state(false);
  readonly ios = ios();
  readonly mobile = mobile();
  private deferred: InstallPromptEvent | null = null;

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); // pas de bandeau automatique : c'est notre bouton qui la propose
      this.deferred = e as InstallPromptEvent;
      this.canPrompt = true;
    });
    window.addEventListener('appinstalled', () => {
      this.deferred = null;
      this.canPrompt = false;
      this.installed = true;
    });
  }

  /** Faut-il proposer l'installation ? */
  get offered(): boolean {
    return !this.installed && (this.canPrompt || this.ios || this.mobile);
  }

  /** Android : ouvre la fenêtre d'installation du navigateur (utilisable une seule fois). */
  async prompt(): Promise<void> {
    const e = this.deferred;
    if (!e) return;
    this.deferred = null;
    this.canPrompt = false;
    await e.prompt();
    if ((await e.userChoice).outcome === 'accepted') this.installed = true;
  }
}

export const install = new Install();
