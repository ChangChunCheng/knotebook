import { useId, type SVGProps } from "react";


/** Official GitLab tanuki (about.gitlab.com/images/press/press-kit-icon.svg) in brand colours, not currentColor. The viewBox is the content bounds (the original 380x380 has large margins). */
export function GitLabLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="109 110 160 160" {...props}>
      <path fill="#E24329" d="M265.26416,174.37243l-.2134-.55822-21.19899-55.30908c-.4236-1.08359-1.18542-1.99642-2.17699-2.62689-.98837-.63373-2.14749-.93253-3.32305-.87014-1.1689.06239-2.29195.48925-3.20809,1.21821-.90957.73554-1.56629,1.73047-1.87493,2.85346l-14.31327,43.80662h-57.90965l-14.31327-43.80662c-.30864-1.12299-.96536-2.11791-1.87493-2.85346-.91614-.72895-2.03911-1.15582-3.20809-1.21821-1.17548-.06239-2.33468.23641-3.32297.87014-.99166.63047-1.75348,1.5433-2.17707,2.62689l-21.19891,55.31237-.21348.55493c-6.28158,16.38521-.92929,34.90803,13.05891,45.48782.02621.01641.04922.03611.07552.05582l.18719.14119,32.29094,24.17392,15.97151,12.09024,9.71951,7.34871c2.34117,1.77316,5.57877,1.77316,7.92002,0l9.71943-7.34871,15.96822-12.09024,32.48142-24.31511c.02958-.02299.05588-.04269.08538-.06568,13.97834-10.57977,19.32735-29.09604,13.04905-45.47796Z" />
      <path fill="#FC6D26" d="M265.26416,174.37243l-.2134-.55822c-10.5174,2.16062-20.20405,6.6099-28.49844,12.81593-.1346.0985-25.20497,19.05805-46.55171,35.19699,15.84998,11.98517,29.6477,22.40405,29.6477,22.40405l32.48142-24.31511c.02958-.02299.05588-.04269.08538-.06568,13.97834-10.57977,19.32735-29.09604,13.04905-45.47796Z" />
      <path fill="#FCA326" d="M160.34962,244.23117l15.97151,12.09024,9.71951,7.34871c2.34117,1.77316,5.57877,1.77316,7.92002,0l9.71943-7.34871,15.96822-12.09024s-13.79772-10.41888-29.6477-22.40405c-15.85327,11.98517-29.65099,22.40405-29.65099,22.40405Z" />
      <path fill="#FC6D26" d="M143.44561,186.63014c-8.29111-6.20274-17.97446-10.65531-28.49507-12.81264l-.21348.55493c-6.28158,16.38521-.92929,34.90803,13.05891,45.48782.02621.01641.04922.03611.07552.05582l.18719.14119,32.29094,24.17392s13.79772-10.41888,29.65099-22.40405c-21.34673-16.13894-46.42031-35.09848-46.55499-35.19699Z" />
    </svg>
  );
}

/**
 * Official Google G (current gradient "super G") from the Google Identity brand page download `signin-assets.zip`: `Android + Web/SVG/Light/Theme=Light, Show text=No, Shape=Square, Platform=Android+Web.svg`. Modified only as follows: button plate and outline removed; viewBox set to the G's content bounds (10 10 20 20, the file's mask area) and root width/height dropped; mask/filter/clipPath ids use `useId` (several on one page don't collide);
 * required JSX attribute and style-object rewrites; Figma `data-figma-*` attributes and the foreignObject div's xhtml xmlns omitted (React builds HTML elements inside foreignObject; no effect on rendering). No colour or path was changed.
 * Google's guidelines want this G on a white background; it is deliberately shown without the white plate.
 */
export function GoogleLogo(props: SVGProps<SVGSVGElement>) {
  // React 19.2's `useId` looks like `_r_0_`, already valid in an id and in `url(#…)`; the `g` prefix only avoids a leading digit.
  const p = `g${useId()}`;
  return (
    <svg viewBox="10 10 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <mask id={`${p}-m`} style={{ maskType: "alpha" }} maskUnits="userSpaceOnUse" x="10" y="10" width="20" height="20">
      <path d="M29.3987 18.1814H19.9849V22.0445H25.3598C25.1286 23.294 24.4294 24.3596 23.3676 25.0712C22.4746 25.6716 21.3266 26.0211 19.9849 26.0211C17.3864 26.0211 15.1823 24.2666 14.3947 21.9004C14.1952 21.2989 14.0853 20.6599 14.0853 19.9983C14.0853 19.3367 14.1952 18.6966 14.3947 18.0962C15.1823 15.7311 17.3864 13.9755 19.9849 13.9755C21.4524 13.9755 22.767 14.4816 23.8039 15.4713L26.6653 12.6057C24.936 10.9908 22.6786 10 19.9849 10C16.0832 10 12.705 12.2414 11.0618 15.5076C10.383 16.8592 10 18.3834 10 19.9994C10 21.6155 10.383 23.1396 11.0618 24.4913C12.705 27.7597 16.0832 30 19.9849 30C22.6797 30 24.9485 29.1137 26.6018 27.5861C28.4887 25.8452 29.5732 23.2702 29.5732 20.2275C29.5732 19.5182 29.5131 18.835 29.3987 18.1825V18.1814Z" fill="#E94FFF"/>
      </mask>
      <g mask={`url(#${p}-m)`}>
      <g filter={`url(#${p}-f0)`}>
      <g clipPath={`url(#${p}-c)`}><g transform="matrix(0.00804129 -0.00805186 0.00804128 0.00805186 19.6819 19.7927)"><foreignObject x="-2105.64" y="-2105.64" width="4211.29" height="4211.29"><div style={{ background: "conic-gradient(from 90deg,rgba(255, 70, 65, 1) 0deg,rgba(255, 70, 65, 1) 4.14555deg,rgba(49, 134, 255, 1) 39.154deg,rgba(49, 134, 255, 1) 72.0044deg,rgba(0, 165, 183, 1) 96.7463deg,rgba(14, 188, 95, 1) 120.897deg,rgba(14, 188, 95, 1) 154.722deg,rgba(108, 196, 0, 1) 179.136deg,rgba(255, 204, 0, 1) 203.588deg,rgba(255, 211, 20, 1) 226.915deg,rgba(255, 204, 0, 1) 251.688deg,rgba(255, 106, 43, 1) 273.129deg,rgba(253, 70, 65, 1) 289.305deg,rgba(255, 70, 65, 1) 359.593deg,rgba(255, 70, 65, 1) 360deg)", height: "100%", width: "100%", opacity: 1 }} /></foreignObject></g></g><path d="M7.25922 19.7927C7.25922 12.6759 13.0209 6.90668 20.1283 6.90668C27.2357 6.90668 32.9973 12.6759 32.9973 19.7927C32.9973 26.9094 27.2357 32.6786 20.1283 32.6786C13.0209 32.6786 7.25921 26.9094 7.25922 19.7927Z"/>
      </g>
      <g filter={`url(#${p}-f1)`}>
      <ellipse cx="20.0496" cy="20.2413" rx="5.39634" ry="2.83537" transform="rotate(24.4473 20.0496 20.2413)" fill="#3186FF"/>
      </g>
      <g filter={`url(#${p}-f2)`}>
      <ellipse cx="33.3538" cy="18.2155" rx="7.43918" ry="3.09357" fill="#3186FF"/>
      </g>
      <g filter={`url(#${p}-f3)`}>
      <ellipse cx="25.2744" cy="16.2195" rx="7.40854" ry="2.37805" fill="#FF4641"/>
      </g>
      <g filter={`url(#${p}-f4)`}>
      <ellipse cx="29.5427" cy="12.9268" rx="7.40854" ry="2.37805" fill="#FF5B8B"/>
      </g>
      <g filter={`url(#${p}-f5)`}>
      <ellipse cx="24.4817" cy="19.878" rx="8.5061" ry="3.10976" fill="#3186FF"/>
      </g>
      <g filter={`url(#${p}-f6)`}>
      <ellipse cx="25.1842" cy="14.0197" rx="4.53882" ry="2.37805" transform="rotate(-28.6599 25.1842 14.0197)" fill="#FF4641"/>
      </g>
      </g>
      <defs>
      <filter id={`${p}-f0`} x="5.25922" y="4.90668" width="29.7381" height="29.772" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
      <feFlood floodOpacity="0" result="BackgroundImageFix"/>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
      <feGaussianBlur stdDeviation="1" result="effect1_foregroundBlur_1298_12516"/>
      </filter>
      <clipPath id={`${p}-c`}><path d="M7.25922 19.7927C7.25922 12.6759 13.0209 6.90668 20.1283 6.90668C27.2357 6.90668 32.9973 12.6759 32.9973 19.7927C32.9973 26.9094 27.2357 32.6786 20.1283 32.6786C13.0209 32.6786 7.25921 26.9094 7.25922 19.7927Z"/></clipPath><filter id={`${p}-f1`} x="12.9977" y="14.828" width="14.1038" height="10.8265" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
      <feFlood floodOpacity="0" result="BackgroundImageFix"/>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
      <feGaussianBlur stdDeviation="1" result="effect1_foregroundBlur_1298_12516"/>
      </filter>
      <filter id={`${p}-f2`} x="23.9146" y="13.1219" width="18.8784" height="10.1871" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
      <feFlood floodOpacity="0" result="BackgroundImageFix"/>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
      <feGaussianBlur stdDeviation="1" result="effect1_foregroundBlur_1298_12516"/>
      </filter>
      <filter id={`${p}-f3`} x="15.8659" y="11.8415" width="18.8171" height="8.7561" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
      <feFlood floodOpacity="0" result="BackgroundImageFix"/>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
      <feGaussianBlur stdDeviation="1" result="effect1_foregroundBlur_1298_12516"/>
      </filter>
      <filter id={`${p}-f4`} x="20.1341" y="8.54878" width="18.8171" height="8.7561" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
      <feFlood floodOpacity="0" result="BackgroundImageFix"/>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
      <feGaussianBlur stdDeviation="1" result="effect1_foregroundBlur_1298_12516"/>
      </filter>
      <filter id={`${p}-f5`} x="13.9756" y="14.7683" width="21.0122" height="10.2195" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
      <feFlood floodOpacity="0" result="BackgroundImageFix"/>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
      <feGaussianBlur stdDeviation="1" result="effect1_foregroundBlur_1298_12516"/>
      </filter>
      <filter id={`${p}-f6`} x="19.0404" y="9.00419" width="12.2878" height="10.0309" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
      <feFlood floodOpacity="0" result="BackgroundImageFix"/>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
      <feGaussianBlur stdDeviation="1" result="effect1_foregroundBlur_1298_12516"/>
      </filter>
      </defs>
    </svg>
  );
}
