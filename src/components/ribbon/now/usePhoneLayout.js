/**
 * usePhoneLayout.js — true below the phone breakpoint. 768 is `MOBILE_BREAKPOINT` of `src/hooks/use-mobile.jsx:3`; that hook
 * calls `window.matchMedia` unguarded, which jsdom does not have, so the Day page reads the width itself and only listens
 * for changes when `matchMedia` exists.
 */
import { useEffect, useState } from 'react';

export const PHONE_BELOW_PX = 768;
const isPhone = () => typeof window !== 'undefined' && window.innerWidth < PHONE_BELOW_PX;

export function usePhoneLayout() {
  const [phone, setPhone] = useState(isPhone);
  useEffect(() => {
    const update = () => setPhone(isPhone());
    update();
    const mql = typeof window.matchMedia === 'function' ? window.matchMedia(`(max-width: ${PHONE_BELOW_PX - 1}px)`) : null;
    mql?.addEventListener('change', update);
    window.addEventListener('resize', update);
    return () => { mql?.removeEventListener('change', update); window.removeEventListener('resize', update); };
  }, []);
  return phone;
}
