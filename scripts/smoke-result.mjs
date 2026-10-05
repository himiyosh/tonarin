export function smokeFailures({ report, version, exit, proxyLog, reportError }) {
  const failures = [];
  if (report == null) failures.push(`the app wrote no report${reportError ? ` (${reportError.message})` : ""}`);
  else if (!Array.isArray(report.problems) || report.problems.some((problem) => typeof problem !== "string")) {
    failures.push("the app wrote an invalid report");
  } else {
    failures.push(...report.problems);
  }
  if (report && report.version !== version) failures.push(`the app reports version ${report.version}, package.json says ${version}`);
  if (exit !== 0) failures.push(`the app exited with ${exit}`);
  const count = (pattern) => (proxyLog.match(pattern) ?? []).length;
  const starts = count(/listening on/g);
  const stops = count(/\[proxy\] stopped/g);
  if (!stops || stops !== starts) failures.push("the proxy did not shut down gracefully");
  return failures;
}
