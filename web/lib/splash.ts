/** Session cookie (no expiry) marking that the brand intro already played in
 *  this browser session. SplashScreen writes it; the root layout's pre-paint
 *  script reads it so later loads skip the intro without a flash. */
export const SPLASH_PLAYED_COOKIE = 'openbooks_splash'

// Runs before first paint. Two concerns, one script so there's a single inline
// <script> in the tree:
//   • theme — apply .dark up front so a dark-mode user never sees a white flash.
//   • nav-internal — flag document loads that should not replay the brand intro:
//     loads that came from within the app itself (e.g. opening an in-app link in
//     a new tab) and any load after the intro has played once in this browser
//     session (SplashScreen records that in a session cookie). The first direct
//     visit of a session still gets the splash. CSS hides the splash while the
//     flag is set so nothing flashes before SplashScreen clears it on mount.
export const HEAD_INIT = `(function(){try{var t=localStorage.getItem('theme')||'system';var m=window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',t==='dark'||(t==='system'&&m));}catch(e){}try{var r=document.referrer;if((r&&new URL(r).origin===location.origin)||document.cookie.split('; ').indexOf('${SPLASH_PLAYED_COOKIE}=1')>=0){document.documentElement.classList.add('nav-internal');}}catch(e){}})();`
