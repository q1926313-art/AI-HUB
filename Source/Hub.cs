using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

sealed class Composer : TextBox
{
    public Action<Image> PasteImage;
    protected override void WndProc(ref Message message)
    {
        if (message.Msg == 0x302 && Clipboard.ContainsImage())
        {
            using (Image image = Clipboard.GetImage())
                if (image != null) PasteImage(image);
            return;
        }
        base.WndProc(ref message);
    }
}

sealed class Chat : Form
{
    readonly RichTextBox conversation = new RichTextBox();
    readonly Composer input = new Composer();
    readonly ListBox attachments = new ListBox();
    static readonly Color Accent = Color.FromArgb(18, 105, 80);
    readonly Button send = new Button();
    readonly Button stop;
    readonly Button removeAttachment;
    readonly RowStyle attachmentRow;
    readonly Label status = new Label();
    readonly TextBox folder = new TextBox();
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    readonly Dictionary<int, TaskCompletionSource<Dictionary<string, object>>> requests =
        new Dictionary<int, TaskCompletionSource<Dictionary<string, object>>>();
    readonly List<string> screenshots = new List<string>();
    readonly HashSet<string> streamed = new HashSet<string>();
    Process server;
    int nextId;
    string thread;
    string turn;
    bool busy;
    bool closing;

    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--apply-hub-update") return GitHubUpdate.Apply(args);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (var chat = new Chat())
        {
            if (args.Length == 1 && args[0] == "--self-test")
            {
                CliProfiles.Read();
                IntPtr handle = chat.Handle;
                return handle != IntPtr.Zero && chat.Text == "AI CLI 허브" ? 0 : 1;
            }
            GitHubUpdate.CleanHelpers();
            Application.Run(chat);
        }
        return 0;
    }

    Chat()
    {
        Text = "AI CLI 허브";
        ClientSize = new Size(900, 680);
        MinimumSize = new Size(560, 490);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Malgun Gothic", 10);
        ForeColor = Color.FromArgb(29, 48, 42);
        BackColor = Color.FromArgb(239, 245, 242);

        var layout = new TableLayoutPanel {
            Dock = DockStyle.Fill, Padding = new Padding(22, 12, 22, 8),
            ColumnCount = 1, RowCount = 5
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 51));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 47));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        Controls.Add(layout);

        var header = Bar();
        header.Controls.Add(new Label {
            Text = "AI CLI 허브", AutoSize = true, Anchor = AnchorStyles.Left,
            Font = new Font(Font.FontFamily, 19, FontStyle.Bold)
        }, 0, 0);
        var headerActions = new FlowLayoutPanel { AutoSize = true, WrapContents = false };
        headerActions.Controls.Add(Button("CLI 등록 및 실행", ManageCli));
        headerActions.Controls.Add(Button("＋ 새 대화", NewChat));
        headerActions.Controls.Add(Button("업데이트 확인", CheckUpdate));
        header.Controls.Add(headerActions, 1, 0);
        layout.Controls.Add(header, 0, 0);

        var workspace = Bar();
        workspace.Margin = new Padding(0, 0, 0, 9);
        workspace.Padding = new Padding(10, 0, 0, 0);
        workspace.BackColor = Color.FromArgb(225, 237, 231);
        var pathBar = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Margin = Padding.Empty };
        pathBar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        pathBar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        pathBar.Controls.Add(new Label { Text = "작업 폴더", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 0);
        folder.Text = Directory.Exists(@"C:\AI\program") ? @"C:\AI\program" : Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        folder.Anchor = AnchorStyles.Left | AnchorStyles.Right;
        folder.Margin = new Padding(8, 0, 8, 0);
        folder.BorderStyle = BorderStyle.None;
        folder.BackColor = workspace.BackColor;
        pathBar.Controls.Add(folder, 1, 0);
        workspace.Controls.Add(pathBar, 0, 0);
        workspace.Controls.Add(Button("폴더 선택", PickFolder), 1, 0);
        layout.Controls.Add(workspace, 0, 1);

        var transcript = new Panel {
            Dock = DockStyle.Fill, Padding = new Padding(18, 14, 12, 14),
            Margin = new Padding(0, 0, 0, 10), BackColor = Color.White
        };
        conversation.Dock = DockStyle.Fill;
        conversation.BorderStyle = BorderStyle.None;
        conversation.ReadOnly = true;
        conversation.BackColor = Color.White;
        conversation.DetectUrls = false;
        conversation.AccessibleName = "대화 내용";
        transcript.Controls.Add(conversation);
        layout.Controls.Add(transcript, 0, 2);

        var composer = new TableLayoutPanel {
            Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 1, RowCount = 3,
            Padding = new Padding(12, 8, 12, 8), Margin = Padding.Empty, BackColor = Color.White
        };
        composer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        attachmentRow = new RowStyle(SizeType.Absolute, 0);
        composer.RowStyles.Add(attachmentRow);
        composer.RowStyles.Add(new RowStyle(SizeType.Absolute, 80));
        composer.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
        attachments.Dock = DockStyle.Fill;
        attachments.IntegralHeight = false;
        attachments.BorderStyle = BorderStyle.None;
        attachments.BackColor = BackColor;
        attachments.HorizontalScrollbar = true;
        attachments.SelectionMode = SelectionMode.MultiExtended;
        attachments.AccessibleName = "첨부 파일 목록";
        attachments.Visible = false;
        composer.Controls.Add(attachments, 0, 0);

        input.Dock = DockStyle.Fill;
        input.BorderStyle = BorderStyle.None;
        input.AccessibleName = "메시지 입력";
        input.Multiline = true;
        input.AcceptsReturn = true;
        input.KeyDown += delegate(object sender, KeyEventArgs e) {
            if (e.KeyData != Keys.Enter) return;
            e.SuppressKeyPress = true;
            send.PerformClick();
        };
        input.ScrollBars = ScrollBars.Vertical;
        input.PasteImage = AddScreenshot;
        composer.Controls.Add(input, 0, 1);

        var toolbar = Bar();
        var files = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Anchor = AnchorStyles.Left, Margin = Padding.Empty };
        files.Controls.Add(Button("＋ 파일 첨부", PickFiles));
        removeAttachment = Button("첨부 제거", RemoveFiles);
        removeAttachment.Visible = false;
        files.Controls.Add(removeAttachment);
        toolbar.Controls.Add(files, 0, 0);
        var actions = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Anchor = AnchorStyles.Right, Margin = Padding.Empty };
        stop = Button("중지", Interrupt);
        stop.Enabled = false;
        actions.Controls.Add(stop);
        send.Text = "보내기";
        StyleButton(send, Accent, Color.White);
        send.Click += SendMessage;
        actions.Controls.Add(send);
        toolbar.Controls.Add(actions, 1, 0);
        composer.Controls.Add(toolbar, 0, 2);
        layout.Controls.Add(composer, 0, 3);

        var footer = Bar();
        var muted = Color.FromArgb(76, 98, 89);
        status.Dock = DockStyle.Fill;
        status.AutoEllipsis = true;
        status.ForeColor = muted;
        status.TextAlign = ContentAlignment.MiddleLeft;
        status.Text = "사진 붙여넣기 · 파일 끌어놓기";
        footer.Controls.Add(status, 0, 0);
        footer.Controls.Add(new Label {
            Text = "Enter 전송  ·  Shift+Enter 줄바꿈", AutoSize = true,
            Anchor = AnchorStyles.Right, ForeColor = muted
        }, 1, 0);
        layout.Controls.Add(footer, 0, 4);

        foreach (Control target in new Control[] { this, input, conversation, attachments })
        {
            target.AllowDrop = true;
            target.DragEnter += delegate(object sender, DragEventArgs e) {
                if (e.Data.GetDataPresent(DataFormats.FileDrop)) e.Effect = DragDropEffects.Copy;
            };
            target.DragDrop += delegate(object sender, DragEventArgs e) {
                foreach (string path in (string[])e.Data.GetData(DataFormats.FileDrop)) AddFile(path);
            };
        }
        Shown += delegate { input.Focus(); };
        FormClosing += delegate(object sender, FormClosingEventArgs args) {
            if (busy && MessageBox.Show("실행 중인 작업을 중단하고 닫을까요?", Text,
                MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
            {
                args.Cancel = true;
                return;
            }
            closing = true;
            if (server != null)
            {
                try { server.StandardInput.Close(); } catch (InvalidOperationException) { }
            }
        };
        FormClosed += delegate {
            foreach (string path in screenshots)
                try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        };
    }

    async void CheckUpdate(object sender, EventArgs args)
    {
        var button = (Button)sender;
        button.Enabled = false;
        try
        {
            status.Text = "GitHub에서 업데이트 확인 중...";
            var release = await Task.Run(() => GitHubUpdate.Check());
            if (closing) return;
            if (release == null)
            {
                status.Text = "설치할 새 버전이 없습니다.";
                return;
            }
            if (busy)
            {
                status.Text = "실행 중인 작업을 마친 뒤 업데이트를 다시 눌러 주세요.";
                return;
            }

            GitHubUpdate.StartInstaller(release);
            Close();
        }
        catch (Exception ex)
        {
            if (!closing) status.Text = "업데이트 실패. " + ex.Message;
        }
        finally
        {
            if (!closing) button.Enabled = true;
        }
    }

    static TableLayoutPanel Bar()
    {
        var bar = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Margin = Padding.Empty };
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        return bar;
    }

    static void StyleButton(Button button, Color background, Color foreground)
    {
        button.AutoSize = true;
        button.MinimumSize = new Size(0, 32);
        button.Padding = new Padding(8, 0, 8, 0);
        button.Margin = new Padding(0, 2, 5, 2);
        button.Anchor = AnchorStyles.Right;
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 0;
        button.BackColor = background;
        button.ForeColor = foreground;
        button.UseVisualStyleBackColor = false;
    }

    Button Button(string title, EventHandler handler)
    {
        var button = new Button { Text = title };
        StyleButton(button, Color.FromArgb(222, 235, 229), ForeColor);
        button.Click += handler;
        return button;
    }

    void UpdateAttachments()
    {
        bool hasFiles = attachments.Items.Count > 0;
        attachmentRow.Height = hasFiles ? 56 : 0;
        attachments.Visible = hasFiles;
        removeAttachment.Visible = hasFiles;
    }

    void PickFolder(object sender, EventArgs e)
    {
        if (busy || thread != null)
        {
            status.Text = "작업 폴더를 바꾸려면 새 대화를 시작하세요.";
            return;
        }
        using (var dialog = new FolderBrowserDialog { SelectedPath = folder.Text })
            if (dialog.ShowDialog(this) == DialogResult.OK) folder.Text = dialog.SelectedPath;
    }

    void PickFiles(object sender, EventArgs e)
    {
        using (var dialog = new OpenFileDialog { Multiselect = true, CheckFileExists = true })
            if (dialog.ShowDialog(this) == DialogResult.OK)
                foreach (string path in dialog.FileNames) AddFile(path);
    }

    void RemoveFiles(object sender, EventArgs e)
    {
        while (attachments.SelectedIndices.Count > 0)
            attachments.Items.RemoveAt(attachments.SelectedIndices[0]);
        UpdateAttachments();
    }

    void AddFile(string path)
    {
        if (File.Exists(path) && !attachments.Items.Contains(path))
        {
            attachments.Items.Add(path);
            UpdateAttachments();
        }
    }

    void AddScreenshot(Image image)
    {
        try
        {
            string path = Path.Combine(Path.GetTempPath(), "codex-chat-" + Guid.NewGuid().ToString("N") + ".png");
            image.Save(path, ImageFormat.Png);
            screenshots.Add(path);
            AddFile(path);
        }
        catch (Exception ex) { status.Text = "사진 저장 실패 · " + ex.Message; }
    }

    void NewChat(object sender, EventArgs e)
    {
        if (busy) return;
        thread = null;
        folder.ReadOnly = false;
        conversation.Clear();
        streamed.Clear();
        status.Text = "새 대화";
        input.Focus();
    }

    async void Interrupt(object sender, EventArgs e)
    {
        if (thread == null || turn == null) return;
        try { await Request("turn/interrupt", new { threadId = thread, turnId = turn }); }
        catch (Exception ex) { status.Text = ex.Message; }
    }

    void Append(string text, Color color)
    {
        conversation.SelectionStart = conversation.TextLength;
        conversation.SelectionLength = 0;
        conversation.SelectionColor = color;
        conversation.AppendText(text);
        conversation.ScrollToCaret();
    }

    void SetBusy(bool value)
    {
        busy = value;
        send.Enabled = !value;
        stop.Enabled = value;
    }

    async void SendMessage(object sender, EventArgs e)
    {
        if (busy || (String.IsNullOrWhiteSpace(input.Text) && attachments.Items.Count == 0)) return;
        if (!Directory.Exists(folder.Text)) { status.Text = "유효한 작업 폴더를 선택하세요."; return; }
        string message = input.Text;
        var items = new List<object>();
        var files = new List<string>();
        foreach (string path in attachments.Items)
        {
            if (!File.Exists(path)) { status.Text = "파일을 찾을 수 없습니다 · " + path; return; }
            files.Add(path);
        }
        var prompt = new StringBuilder(message);
        foreach (string path in files)
        {
            string ext = Path.GetExtension(path).ToLowerInvariant();
            if (ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".webp" || ext == ".gif")
                items.Add(new { type = "localImage", path = path });
            else
                prompt.AppendLine().Append("첨부 로컬 파일: ").Append(path);
        }
        if (String.IsNullOrWhiteSpace(prompt.ToString())) prompt.Append("첨부 이미지를 확인해 주세요.");
        items.Insert(0, new { type = "text", text = prompt.ToString(), text_elements = new object[0] });
        SetBusy(true);
        status.Text = "Codex에 연결 중…";
        try
        {
            if (server == null || server.HasExited) await StartServer();
            if (thread == null)
            {
                var started = await Request("thread/start", new { cwd = Path.GetFullPath(folder.Text) });
                thread = Str(Obj(started, "thread"), "id");
                folder.ReadOnly = true;
            }
            Append("\n나\n" + message + "\n", Accent);
            foreach (string path in files) Append("첨부 · " + Path.GetFileName(path) + "\n", Color.SlateGray);
            var response = await Request("turn/start", new { threadId = thread, input = items });
            if (busy) turn = Str(Obj(response, "turn"), "id");
            if (input.Text == message) input.Clear();
            foreach (string path in files) attachments.Items.Remove(path);
        }
        catch (Exception ex) { status.Text = "전송 실패 · " + ex.Message; SetBusy(false); }
    }

    void ManageCli(object sender, EventArgs args)
    {
        if (busy) return;
        try
        {
            using (var dialog = new CliProfiles(folder.Text))
                if (dialog.ShowDialog(this) == DialogResult.OK && server != null)
                {
                    if (!server.HasExited) server.Kill();
                    server = null;
                    NewChat(this, EventArgs.Empty);
                }
        }
        catch (Exception ex) { status.Text = ex.Message; }
    }

    async Task StartServer()
    {
        thread = null;
        turn = null;
        string executable = CliProfiles.Read()[0];
        if (String.IsNullOrWhiteSpace(executable)) executable = Environment.GetEnvironmentVariable("CODEX_CHAT_CLI");
        if (String.IsNullOrWhiteSpace(executable))
        {
            executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                @"Programs\OpenAI\Codex\bin\codex.exe");
            if (!File.Exists(executable)) executable = "codex.exe";
        }
        var process = new Process();
        process.StartInfo = new ProcessStartInfo(executable, "app-server --listen stdio://") {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = Path.GetFullPath(folder.Text)
        };
        process.EnableRaisingEvents = true;
        process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) {
            if (e.Data != null) OnUi(delegate { if (server == process) Receive(e.Data); });
            else OnUi(delegate { if (server == process) Disconnected(); });
        };
        process.ErrorDataReceived += delegate { };
        process.Start();
        server = process;
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        try
        {
            await Request("initialize", new { clientInfo = new { name = "codex_chat_windows", title = "AI CLI 허브", version = "0.1.0" } });
            Write(new { method = "initialized" });
        }
        catch
        {
            try { process.StandardInput.Close(); } catch (InvalidOperationException) { }
            if (server == process) server = null;
            throw;
        }
    }

    void Disconnected()
    {
        var pending = new List<TaskCompletionSource<Dictionary<string, object>>>(requests.Values);
        requests.Clear();
        server = null;
        thread = null;
        turn = null;
        folder.ReadOnly = false;
        SetBusy(false);
        status.Text = "Codex 연결이 종료됐어요.";
        foreach (var request in pending) request.TrySetException(new IOException(status.Text));
    }

    void OnUi(Action action)
    {
        if (!closing && IsHandleCreated)
            try { BeginInvoke(action); } catch (InvalidOperationException) { }
    }

    void Write(object value)
    {
        // Send UTF-8 JSONL directly, independent of the Windows console code page.
        byte[] bytes = Encoding.UTF8.GetBytes(json.Serialize(value) + "\n");
        Stream stream = server.StandardInput.BaseStream;
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush();
    }

    async Task<Dictionary<string, object>> Request(string method, object payload)
    {
        int id = ++nextId;
        var promise = new TaskCompletionSource<Dictionary<string, object>>();
        requests.Add(id, promise);
        try
        {
            Write(new { id = id, method = method, @params = payload });
            if (await Task.WhenAny(promise.Task, Task.Delay(30000)) != promise.Task)
                throw new TimeoutException(method + " 응답 시간 초과");
            return await promise.Task;
        }
        finally { requests.Remove(id); }
    }

    void Receive(string line)
    {
        try
        {
            var frame = json.Deserialize<Dictionary<string, object>>(line);
            object id;
            string method = Str(frame, "method");
            if (frame.TryGetValue("id", out id))
            {
                if (method.Length > 0) { Approval(id, method, Obj(frame, "params")); return; }
                TaskCompletionSource<Dictionary<string, object>> promise;
                int number;
                if (Int32.TryParse(Convert.ToString(id), out number) && requests.TryGetValue(number, out promise))
                {
                    var error = Obj(frame, "error");
                    if (error.Count > 0) promise.TrySetException(new InvalidOperationException(Str(error, "message")));
                    else promise.TrySetResult(Obj(frame, "result"));
                }
                return;
            }

            var data = Obj(frame, "params");
            if (thread == null || Str(data, "threadId") != thread) return;
            if (method == "turn/started")
            {
                turn = Str(Obj(data, "turn"), "id");
                status.Text = "Codex 작업 중…";
            }
            else if (method == "item/agentMessage/delta")
            {
                if (streamed.Add(Str(data, "itemId"))) Append("\nCodex\n", Accent);
                Append(Str(data, "delta"), ForeColor);
            }
            else if (method == "item/completed")
            {
                var item = Obj(data, "item");
                if (Str(item, "type") == "agentMessage")
                {
                    if (!streamed.Contains(Str(item, "id")))
                        Append("\nCodex\n" + Str(item, "text"), ForeColor);
                    Append("\n", Color.Black);
                }
            }
            else if (method == "turn/completed")
            {
                var result = Obj(data, "turn");
                string state = Str(result, "status");
                string error = Str(Obj(result, "error"), "message");
                status.Text = error.Length > 0 ? error : state == "completed" ? "완료" : "작업 상태 · " + state;
                if (error.Length > 0) Append("\n" + error + "\n", Color.Firebrick);
                streamed.Clear();
                turn = null;
                SetBusy(false);
            }
        }
        catch (Exception ex) { status.Text = "Codex 응답 처리 오류 · " + ex.Message; }
    }

    void Approval(object id, string method, Dictionary<string, object> data)
    {
        bool command = method == "item/commandExecution/requestApproval";
        if (command || method == "item/fileChange/requestApproval")
        {
            string detail = Str(data, "reason");
            if (command) detail += "\n" + Str(data, "command") + "\n" + Str(data, "cwd");
            else detail += "\n" + Str(data, "grantRoot");
            bool allow = MessageBox.Show(this, detail.Trim(), command ? "명령 실행 승인" : "파일 변경 승인",
                MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) == DialogResult.Yes;
            Write(new { id = id, result = new { decision = allow ? "accept" : "decline" } });
        }
        else
        {
            status.Text = "이 버전에서 지원하지 않는 요청 · " + method;
            Write(new { id = id, error = new { code = -32601, message = "Unsupported client request" } });
        }
    }

    static Dictionary<string, object> Obj(Dictionary<string, object> data, string key)
    {
        object value;
        return data.TryGetValue(key, out value) && value is Dictionary<string, object>
            ? (Dictionary<string, object>)value : new Dictionary<string, object>();
    }

    static string Str(Dictionary<string, object> data, string key)
    {
        object value;
        return data.TryGetValue(key, out value) ? Convert.ToString(value) : "";
    }
}
