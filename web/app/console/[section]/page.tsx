import { redirect, notFound } from 'next/navigation';
import { serverSession } from '@/lib/server/session';
import { SECTIONS } from '@continuum/contracts';
import { ConsoleApp } from '@/components/ConsoleApp';
export const dynamic = 'force-dynamic';
export default async function Page({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!SECTIONS.includes(section as any)) notFound();
  const session = await serverSession();
  if (!session) redirect('/sign-in');
  return <ConsoleApp section={section} mode={session.mode} />;
}
