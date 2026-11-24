using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Windows.Forms;
using System.Drawing;

sealed class UpdateVerifier : Form
{
    readonly string target = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "AI CLI Hub.exe");
    readonly Button apply = new Button { Text = "업데이트 반영", AutoSize = true, Enabled = false };
    readonly Label status = new Label { Dock = DockStyle.Fill, Padding = new Padding(8) };
    string staged;
    string verifiedHash;

    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--verify")
        {
            try { Verify(Path.GetFullPath(args[1])); return 0; }
            catch { return 1; }
        }
        Application.EnableVisualStyles();
        Application.Run(new UpdateVerifier());
        return 0;
    }

    UpdateVerifier()
    {
        Text = "AI CLI 허브 업데이트 검증";
        ClientSize = new Size(530, 138);
        status.Text = "직접 빌드했거나 신뢰하는 출처의 AI CLI Hub.exe를 선택하세요.";
        var controls = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 46, Padding = new Padding(6) };
        var select = new Button { Text = "새 버전 선택 및 검증", AutoSize = true };
        select.Click += SelectCandidate;
        apply.Click += ApplyCandidate;
        controls.Controls.Add(select);
        controls.Controls.Add(apply);
        Controls.Add(status);
        Controls.Add(controls);
    }

    void SelectCandidate(object sender, EventArgs args)
    {
        using (var picker = new OpenFileDialog { Filter = "AI CLI Hub.exe|AI CLI Hub.exe" })
        {
            if (picker.ShowDialog(this) != DialogResult.OK) return;
            apply.Enabled = false;
            try
            {
                if (staged != null && File.Exists(staged)) File.Delete(staged);
                staged = Path.Combine(Path.GetDirectoryName(target), ".update-" + Guid.NewGuid().ToString("N") + ".exe");
                File.Copy(picker.FileName, staged);
                verifiedHash = Hash(staged);
                Verify(staged);
                if (verifiedHash != Hash(staged)) throw new IOException("검증 중 파일이 변경되었습니다.");
                status.Text = "시작 및 CLI 설정 읽기 검증을 통과했습니다.";
                apply.Enabled = true;
            }
            catch (Exception ex) { status.Text = "검증 실패. " + ex.Message; }
        }
    }

    void ApplyCandidate(object sender, EventArgs args)
    {
        bool replaced = false;
        string backup = target + "." + Guid.NewGuid().ToString("N") + ".bak";
        try
        {
            if (!File.Exists(target)) throw new IOException("설치된 AI CLI Hub.exe를 찾을 수 없습니다.");
            if (Hash(staged) != verifiedHash) throw new IOException("검증한 파일이 변경되었습니다.");
            File.Replace(staged, target, backup);
            replaced = true;
            Verify(target);
            status.Text = "업데이트 완료. 이전 버전을 백업했습니다.";
        }
        catch (Exception ex)
        {
            status.Text = "반영 실패. " + ex.Message;
            if (replaced)
            {
                try { File.Replace(backup, target, null); status.Text += " 이전 버전을 복원했습니다."; }
                catch (Exception restore) { status.Text += " 복원 실패. 백업: " + backup + " / " + restore.Message; }
            }
        }
        apply.Enabled = false;
    }

    protected override void OnFormClosed(FormClosedEventArgs args)
    {
        if (staged != null && File.Exists(staged))
            try { File.Delete(staged); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        base.OnFormClosed(args);
    }

    static string Hash(string path)
    {
        using (var sha = SHA256.Create())
        using (var stream = File.OpenRead(path))
            return Convert.ToBase64String(sha.ComputeHash(stream));
    }

    internal static void Verify(string path)
    {
        using (var app = Process.Start(new ProcessStartInfo(path, "--self-test") {
            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetDirectoryName(path)
        }))
        {
            if (!app.WaitForExit(12000))
            {
                app.Kill();
                app.WaitForExit(2000);
                throw new IOException("앱 시작 검증 시간이 초과되었습니다.");
            }
            if (app.ExitCode != 0) throw new IOException("앱 시작 또는 CLI 설정을 확인하세요.");
        }
    }
}