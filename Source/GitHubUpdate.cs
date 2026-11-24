using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Windows.Forms;
using System.Web.Script.Serialization;

[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

static class GitHubUpdate
{
    const string Repository = "q1926313-art/AI-HUB";
    const string Asset = "AI-CLI-Hub.exe";
    const string Prefix = ".hub-update-";
    static Version Current { get { return typeof(GitHubUpdate).Assembly.GetName().Version; } }

    internal sealed class Release
    {
        public Version Version;
        public string Url;
        public string Digest;
    }

    internal static Release Check()
    {
        using (var client = Client())
        {
            string json;
            try { json = client.DownloadString("https://api.github.com/repos/" + Repository + "/releases/latest"); }
            catch (WebException ex)
            {
                var response = ex.Response as HttpWebResponse;
                if (response != null && response.StatusCode == HttpStatusCode.NotFound)
                {
                    response.Dispose();
                    return null;
                }
                throw;
            }
            var release = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
            string tag = (string)release["tag_name"];
            Version version;
            if (!tag.StartsWith("v", StringComparison.Ordinal) || !Version.TryParse(tag.Substring(1) + ".0", out version) || version.Revision != 0)
                throw new IOException("릴리스 버전 형식을 확인하세요.");
            if (version <= Current) return null;
            foreach (Dictionary<string, object> asset in (IEnumerable)release["assets"])
            {
                if ((string)asset["name"] != Asset) continue;
                object value;
                string digest = asset.TryGetValue("digest", out value) ? value as string : null;
                if (digest == null || !System.Text.RegularExpressions.Regex.IsMatch(digest, @"\Asha256:[0-9a-fA-F]{64}\z"))
                    throw new IOException("릴리스에 SHA-256 정보가 없습니다.");
                return new Release {
                    Version = version,
                    Url = "https://github.com/" + Repository + "/releases/download/" + Uri.EscapeDataString(tag) + "/" + Asset,
                    Digest = digest.Substring(7)
                };
            }
            throw new IOException("릴리스에 Windows 실행 파일이 없습니다.");
        }
    }

    static WebClient Client()
    {
        ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
        var client = new WebClient();
        client.Headers[HttpRequestHeader.UserAgent] = "AI-CLI-Hub/" + Current.ToString(3);
        return client;
    }

    internal static string Stage(Release release)
    {
        string id = Guid.NewGuid().ToString("N");
        string candidate = Candidate(Application.ExecutablePath, id);
        try
        {
            using (var client = Client()) client.DownloadFile(release.Url, candidate);
            CheckCandidate(candidate, release.Version, release.Digest);
            UpdateVerifier.Verify(candidate);
            return id;
        }
        catch
        {
            Delete(candidate);
            throw;
        }
    }

    internal static void StartInstaller(string id, Release release)
    {
        string target = Application.ExecutablePath;
        string helper = Path.Combine(Path.GetDirectoryName(target), Prefix + id + ".helper.exe");
        try
        {
            File.Copy(target, helper);
            using (var parent = Process.GetCurrentProcess())
            using (Process.Start(new ProcessStartInfo(helper,
                "--apply-hub-update " + parent.Id + " " + parent.StartTime.ToFileTimeUtc() + " " + id + " " +
                release.Version + " " + release.Digest + " \"" + target + "\"") { UseShellExecute = false }))
            { }
        }
        catch
        {
            Delete(helper);
            Delete(Candidate(target, id));
            throw;
        }
    }

    internal static int Apply(string[] args)
    {
        string candidate = null;
        try
        {
            Guid id;
            Version version;
            if (args.Length != 7 || !Guid.TryParseExact(args[3], "N", out id) || !Version.TryParse(args[4], out version))
                throw new IOException("업데이트 매개 변수가 올바르지 않습니다.");
            string target = Path.GetFullPath(args[6]);
            string directory = Path.GetDirectoryName(Application.ExecutablePath);
            if (!String.Equals(directory, Path.GetDirectoryName(target), StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(Path.GetFileName(Application.ExecutablePath), Prefix + id.ToString("N") + ".helper.exe", StringComparison.OrdinalIgnoreCase))
                throw new IOException("설치 경로가 일치하지 않습니다.");
            candidate = Candidate(target, id.ToString("N"));
            Process parent;
            try { parent = Process.GetProcessById(Int32.Parse(args[1])); }
            catch (ArgumentException) { parent = null; }
            if (parent != null)
                using (parent)
                    if (!parent.HasExited && parent.StartTime.ToFileTimeUtc() == Int64.Parse(args[2]) && !parent.WaitForExit(30000))
                        throw new IOException("프로그램 종료 시간이 초과되었습니다.");

            if (version <= AssemblyName.GetAssemblyName(target).Version)
                throw new IOException("이미 같은 버전 또는 더 최신 버전이 설치되어 있습니다.");
            CheckCandidate(candidate, version, args[5]);
            string backup = target + "." + id.ToString("N") + ".bak";
            File.Replace(candidate, target, backup);
            try
            {
                UpdateVerifier.Verify(target);
                using (Process.Start(new ProcessStartInfo(target) { UseShellExecute = false, WorkingDirectory = directory })) { }
            }
            catch
            {
                File.Replace(backup, target, null);
                throw;
            }
            return 0;
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "업데이트 실패", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        finally { Delete(candidate); }
    }

    internal static void CleanHelpers()
    {
        try
        {
            foreach (string file in Directory.GetFiles(AppDomain.CurrentDomain.BaseDirectory, Prefix + "*.helper.exe"))
                if (System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(file), @"\A\.hub-update-[0-9a-f]{32}\.helper\.exe\z"))
                    Delete(file);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    internal static void Discard(string id) { Delete(Candidate(Application.ExecutablePath, id)); }

    static string Candidate(string target, string id)
    {
        return Path.Combine(Path.GetDirectoryName(target), Prefix + id + ".candidate.exe");
    }

    static void CheckCandidate(string path, Version version, string expected)
    {
        using (var sha = SHA256.Create())
        using (var stream = File.OpenRead(path))
        {
            string actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "");
            if (!String.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
                throw new IOException("다운로드 파일의 SHA-256이 일치하지 않습니다.");
        }
        if (AssemblyName.GetAssemblyName(path).Version != version)
            throw new IOException("다운로드 파일 버전이 릴리스와 일치하지 않습니다.");
    }

    static void Delete(string path)
    {
        if (path == null) return;
        try { File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
