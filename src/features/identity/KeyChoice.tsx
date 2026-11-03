import { Button } from "../../shared/design-system/ui/Button";
import styles from "./IdentitySetup.module.css";
import { OnboardingScreen } from "./OnboardingScreen";

/** Create and link a key, or import one, with automatic Builderlab backup. */
export function KeyChoice({
  email,
  onCreate,
  onImport,
  onSwitchAccount,
}: {
  email?: string | undefined;
  /** Create the key, link it to the account, then back it up. */
  onCreate: () => void;
  /** The user already has a key: open the import page. */
  onImport: () => void;
  /** Wrong account: sign the session out and return to the landing. */
  onSwitchAccount: () => void;
}) {
  // The welcome screen's create-or-import stack, after sign-in.
  return (
    <OnboardingScreen
      labelledBy="welcome-title"
      intro={
        <div className={styles.importContent}>
          <h1
            id="welcome-title"
            tabIndex={-1}
            className="text-heading text-standard"
          >
            Get started with Buzz
          </h1>
          <p className="text-body text-subtle">
            We’ll create a private key that represents you in Buzz. Your key is
            backed up to your Builderlab account automatically. Block can use
            that copy to restore this key, including anywhere else you use it.
          </p>
          {email && (
            <p className="break-words text-body-sm text-subtle">
              Signed in as {email}
            </p>
          )}
        </div>
      }
    >
      <Button variant="prominent" size="lg" onClick={onCreate}>
        Create my key
      </Button>
      <Button
        variant="subtle"
        size="lg"
        data-return-focus="import"
        onClick={onImport}
      >
        Use an existing key
      </Button>
      <Button variant="ghost" size="lg" onClick={onSwitchAccount}>
        Use a different account
      </Button>
    </OnboardingScreen>
  );
}
