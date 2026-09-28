/**
 * "Se connecter avec Google" via Google Identity Services.
 * Le script de Google est chargé seulement si un client ID est configuré.
 */

interface GoogleCredentialResponse {
  credential: string;
}

interface GoogleIdApi {
  initialize(options: {
    client_id: string;
    callback: (res: GoogleCredentialResponse) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    use_fedcm_for_button?: boolean;
  }): void;
  renderButton(
    parent: HTMLElement,
    options: {
      type?: "standard" | "icon";
      theme?: "outline" | "filled_blue" | "filled_black";
      size?: "large" | "medium" | "small";
      text?: "signin_with" | "signup_with" | "continue_with" | "signin";
      shape?: "rectangular" | "pill" | "circle" | "square";
      locale?: string;
      width?: number;
    },
  ): void;
  disableAutoSelect(): void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleIdApi } };
  }
}

let ready: Promise<GoogleIdApi> | null = null;

function loadScript(): Promise<GoogleIdApi> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => (window.google ? resolve(window.google.accounts.id) : reject(new Error("GIS absent")));
    script.onerror = () => reject(new Error("Impossible de charger Google"));
    document.head.appendChild(script);
  });
}

/** Charge Google une seule fois. `onCredential` reçoit le jeton de chaque connexion. */
export function initGoogle(clientId: string, onCredential: (credential: string) => void): Promise<GoogleIdApi> {
  if (!ready) {
    ready = loadScript().then((gis) => {
      gis.initialize({
        client_id: clientId,
        callback: (res) => onCredential(res.credential),
        auto_select: false,
        cancel_on_tap_outside: true,
        use_fedcm_for_button: true,
      });
      return gis;
    });
  }
  return ready;
}

export async function renderGoogleButton(parent: HTMLElement): Promise<void> {
  if (!ready) return;
  const gis = await ready;
  parent.replaceChildren();
  gis.renderButton(parent, {
    theme: "filled_black",
    size: "large",
    text: "continue_with",
    shape: "pill",
    locale: "fr",
    width: Math.min(320, parent.clientWidth || 320),
  });
}

export async function forgetGoogleChoice(): Promise<void> {
  if (ready) (await ready).disableAutoSelect();
}
