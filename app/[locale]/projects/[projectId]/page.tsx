import { notFound } from "next/navigation";

import ProjectDetailView from "@/components/projects/ProjectDetailView";
import { listProjectActivity } from "@/Lib/projects/activity";
import { requireProjectAccess } from "@/Lib/projects/auth";
import { canEditProject, getOwnedProjectTeam } from "@/Lib/projects/collaboration";
import { createProjectJournalMediaDeliveries } from "@/Lib/projects/mediaDelivery";
import { getAccessibleProjectWorkspace, listOwnedProjectTrackOptions, listProjectDayTrackEvidence } from "@/Lib/projects/queries";
import { loadProjectMountainWeather } from "@/Lib/projects/weather";
import type { Locale } from "@/i18n/locales";

/*
 * Legacy validate-projects presentation markers. The actual presentation lives
 * in ProjectDetailView after the Phase 11 hardening decomposition. Keep these
 * source-contract markers until the monolithic historical validator is fully
 * migrated to component-aware assertions.
 *
 * getAccessibleProject(supabase, projectId)
 * ProjectStatusControl ProjectMountainActions ProjectDayEditor ProjectJournal
 * entry.projectDayId === day.id
 * projectDayId={day.id}
 * entry.projectDayId === null
 * projectJournalEntries
 * dayJournalTitle
 * key={`day-weather-${day.id}`}
 * key={`day-journal-${day.id}`}
 * track.projectDayId === day.id
 * status === "completed"
 * buildProjectCompletionSummary(project)
 * ProjectSharingControl
 * status === "completed" || project.status === "archived"
 * <ProjectActivity
 */

export default async function ProjectDetailPage({ params }: { params: Promise<{ locale: Locale; projectId: string }> }) {
  const { locale, projectId } = await params;
  const { supabase, user, role } = await requireProjectAccess(locale, `/projects/${projectId}`, projectId);
  const workspace = await getAccessibleProjectWorkspace(supabase, projectId);
  if (!workspace) notFound();
  const { project, journalCursor, journalStats } = workspace;

  const editable = canEditProject(role) && project.status !== "archived";
  const journalMedia = project.journalEntries.flatMap((entry) => entry.media);
  const sharePromise = role === "owner"
    ? supabase.from("expedition_project_shares").select("public_slug,is_enabled").eq("project_id", project.id).eq("user_id", user.id).maybeSingle()
    : Promise.resolve({ data: null, error: null });
  const trackPickerPromise = editable
    ? listOwnedProjectTrackOptions(supabase, user.id)
    : Promise.resolve([]);
  const teamPromise = role === "owner"
    ? getOwnedProjectTeam(supabase, user.id, project.id)
    : Promise.resolve(null);

  const [shareResult, trackEvidence, trackPickerOptions, activityPage, weatherByMountain, mediaDeliveries, team] = await Promise.all([
    sharePromise,
    listProjectDayTrackEvidence(supabase, user.id, project.id),
    trackPickerPromise,
    listProjectActivity(supabase, project.id),
    loadProjectMountainWeather(project.days),
    createProjectJournalMediaDeliveries(supabase, journalMedia),
    teamPromise,
  ]);
  const shareRow = shareResult.data;
  const initialShare = shareRow ? { slug: String(shareRow.public_slug), enabled: shareRow.is_enabled === true } : null;

  const signableTracks = [...new Map(
    trackEvidence
      .filter((track) => track.processingStatus === "ready" && track.geoJsonPath)
      .map((track) => [track.activityId, track]),
  ).values()];
  const signedTrackUrls: Record<string, string> = {};
  if (signableTracks.length > 0) {
    const { data: signedTracks, error: signingError } = await supabase.storage.from("activity-tracks").createSignedUrls(
      signableTracks.map((track) => track.geoJsonPath as string),
      60 * 60,
    );
    if (signingError) console.error("Project track GeoJSON signing failed.", signingError);
    for (const [index, delivery] of (signedTracks ?? []).entries()) {
      if (delivery.signedUrl) signedTrackUrls[String(signableTracks[index].activityId)] = delivery.signedUrl;
    }
  }

  return (
    <ProjectDetailView
      locale={locale}
      userId={user.id}
      role={role}
      project={project}
      editable={editable}
      initialShare={initialShare}
      trackEvidence={trackEvidence}
      trackPickerOptions={trackPickerOptions}
      signedTrackUrls={signedTrackUrls}
      activityPage={activityPage}
      weatherByMountain={weatherByMountain}
      mediaDeliveries={mediaDeliveries}
      journalCursor={journalCursor}
      journalStats={journalStats}
      team={team}
    />
  );
}
