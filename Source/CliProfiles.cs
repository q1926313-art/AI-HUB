using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
using System.Drawing;

sealed class CliProfiles : Form
{
    static readonly string[] Names = { "Codex CLI", "Claude CLI", "OpenCode Go CLI" };
    static readonly string Config = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AI CLI Hub", "cli-paths.txt");
    readonly TextBox[] paths = new TextBox[Names.Length];

    internal static string[] Read()
    {
        string[] result = new string[Names.Length];
        if (File.Exists(Config))
        {
            string[] stored = File.ReadAllLines(Config);
            if (stored.Length != result.Length) throw new InvalidDataException("CLI 등록 설정을 읽을 수 없습니다.");
            Array.Copy(stored, result, result.Length);
        }
        return result;
    }

    internal CliProfiles(string folder)
    {
        Text = "CLI 등록 및 실행";
        ClientSize = new Size(730, 165);
        StartPosition = FormStartPosition.CenterParent;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, Padding = new Padding(8) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        Controls.Add(layout);
        string[] saved = Read();
        for (int i = 0; i < Names.Length; i++)
        {
            int index = i;
            var path = paths[i] = new TextBox { Dock = DockStyle.Fill, Text = saved[i] };
            layout.Controls.Add(new Label { Text = Names[i], AutoSize = true }, 0, i);
            layout.Controls.Add(path, 1, i);
            var browse = new Button { Text = "찾아보기", AutoSize = true };
            browse.Click += delegate {
                using (var picker = new OpenFileDialog { Filter = index == 0 ?
                    "실행 파일|*.exe" : "CLI 실행 파일|*.exe;*.cmd;*.bat" })
                    if (picker.ShowDialog(this) == DialogResult.OK) path.Text = picker.FileName;
            };
            layout.Controls.Add(browse, 2, i);
            if (i == 0) continue;
            var launch = new Button { Text = "열기", AutoSize = true };
            launch.Click += delegate {
                try
                {
                    string executable = Validate(path.Text, index);
                    if (executable.Length == 0) throw new InvalidOperationException("CLI 실행 파일을 선택하세요.");
                    using (Process.Start(new ProcessStartInfo(executable) {
                        UseShellExecute = true, WorkingDirectory = Path.GetFullPath(folder)
                    })) { }
                }
                catch (Exception ex) { MessageBox.Show(this, ex.Message); }
            };
            layout.Controls.Add(launch, 3, i);
        }
        var save = new Button { Text = "저장", AutoSize = true };
        save.Click += delegate {
            try
            {
                string[] values = new string[paths.Length];
                for (int i = 0; i < paths.Length; i++) values[i] = Validate(paths[i].Text, i);
                Directory.CreateDirectory(Path.GetDirectoryName(Config));
                string temporary = Config + "." + Guid.NewGuid().ToString("N");
                try
                {
                    File.WriteAllLines(temporary, values);
                    if (File.Exists(Config)) File.Replace(temporary, Config, null);
                    else File.Move(temporary, Config);
                }
                finally { if (File.Exists(temporary)) File.Delete(temporary); }
                DialogResult = DialogResult.OK;
            }
            catch (Exception ex) { MessageBox.Show(this, ex.Message); }
        };
        layout.Controls.Add(save, 3, 3);
    }

    static string Validate(string value, int index)
    {
        value = value.Trim();
        if (value.Length == 0) return value;
        string extension = Path.GetExtension(value).ToLowerInvariant();
        if (!Path.IsPathRooted(value) || !File.Exists(value) ||
            (extension != ".exe" && (index == 0 || (extension != ".cmd" && extension != ".bat"))))
            throw new InvalidOperationException(Names[index] + " 실행 파일 경로를 확인하세요.");
        return Path.GetFullPath(value);
    }
}