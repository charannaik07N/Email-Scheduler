import { useLayoutEffect, useRef, useState } from "react";
import { GoogleLogin } from "@react-oauth/google";
import type { CredentialResponse } from "@react-oauth/google";
import { useAuth } from "./AuthContext";
import { usePrefersDark } from "../ui/usePrefersDark";

interface GoogleAuthProps {
  onError?: (error: string) => void;
}

// Google draws its button at a fixed pixel width (200 to 400). It gets the
// room the card has, up to 300, so it never pushes a phone screen sideways.
const MIN_BUTTON_WIDTH = 200;
const MAX_BUTTON_WIDTH = 300;

const useAvailableWidth = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(MAX_BUTTON_WIDTH);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () =>
      setWidth(Math.max(MIN_BUTTON_WIDTH, Math.min(MAX_BUTTON_WIDTH, Math.floor(element.clientWidth))));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
};

export const GoogleAuth = ({ onError }: GoogleAuthProps) => {
  const { loginWithGoogle } = useAuth();
  const prefersDark = usePrefersDark();
  const [wrapperRef, buttonWidth] = useAvailableWidth();

  const handleLoginSuccess = async (credentialResponse: CredentialResponse) => {
    if (!credentialResponse.credential) {
      onError?.("Google didn’t return a sign-in credential. Please try again.");
      return;
    }
    try {
      await loginWithGoogle(credentialResponse.credential);
    } catch (error) {
      console.error("Backend login failed:", error);
      onError?.("Sign-in failed. Please try again.");
    }
  };

  // Fires for a closed popup, a network problem or a misconfigured origin alike.
  const handleLoginError = () => {
    console.error(
      `Google sign-in failed. If this keeps happening, check that ${window.location.origin} is an authorized JavaScript origin for the Google client ID.`
    );
    onError?.("Google sign-in didn’t complete. Please try again.");
  };

  // Google's own button (its branding is required); themed to match light/dark.
  return (
    <div className="app-login__google" ref={wrapperRef}>
      <GoogleLogin
        key={`${prefersDark ? "dark" : "light"}-${buttonWidth}`}
        onSuccess={handleLoginSuccess}
        onError={handleLoginError}
        theme={prefersDark ? "filled_black" : "outline"}
        size="large"
        width={buttonWidth}
        text="continue_with"
        shape="pill"
        use_fedcm_for_prompt={false}
      />
    </div>
  );
};
