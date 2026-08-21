import { requireProjectUser } from "@/Lib/projects/auth";
import ProjectCreateForm from "@/components/projects/ProjectCreateForm";
import type { Locale } from "@/i18n/locales";

export default async function NewProjectPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  await requireProjectUser(locale, "/projects/new");

  return (
    <main className="min-h-[calc(100dvh-58px)] bg-[var(--color-bg)] px-4 py-6 lg:min-h-[calc(100dvh-66px)] lg:px-6 lg:py-9">
      <ProjectCreateForm />
    </main>
  );
}
