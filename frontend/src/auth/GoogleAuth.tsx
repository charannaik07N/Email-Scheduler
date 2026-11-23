import { GoogleLogin } from "@react-oauth/google";
import type { CredentialResponse } from "@react-oauth/google";
import { useAuth } from "./AuthContext";
import { usePrefersDark } from "../ui/usePrefersDark";

interface GoogleAuthProps {
  onError?: (error: string) => void;
}

export const GoogleAuth = ({ onError }: GoogleAuthProps) => {
  const { loginWithGoogle } = useAuth();
  const prefersDark = usePrefersDark();

  const handleLoginSuccess = async (credentialResponse: CredentialResponse) => {
    if (!credentialResponse.credential) {
      onError?.("Google didn't return a sign-in credential. Please try again.");
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
    onError?.("Google sign-in didn't complete. Please try again.");
  };

  // Google's own button (its branding is required); themed to match light/dark.
  return (
    <div className="app-login__google">
      <GoogleLogin
        key={prefersDark ? "dark" : "light"}
        onSuccess={handleLoginSuccess}
        onError={handleLoginError}
        theme={prefersDark ? "filled_black" : "outline"}
        size="large"
        width={300}
        text="continue_with"
        shape="pill"
        use_fedcm_for_prompt={false}
      />
    </div>
  );
};
