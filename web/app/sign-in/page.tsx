import { configuredAuth, fixtureMode } from '@/lib/server/session';
import { SignIn } from '@/components/SignIn';
export const dynamic = 'force-dynamic';
export default function Page() {
  return <SignIn local={fixtureMode()} configured={configuredAuth()} />;
}
