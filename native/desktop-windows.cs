// DODO owner-permitted window adapter. .NET Framework + inbox Win32 APIs.
// JSON stdin only; no shell, clipboard, arbitrary code, process launch or privilege elevation.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

class DodoDesktop {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 5 * 1024 * 1024, RecursionLimit = 24 };
  delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; public Point(int x,int y){X=x;Y=y;} }
  [StructLayout(LayoutKind.Sequential)] struct Mouse { public int X,Y; public uint Data,Flags,Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] struct Key { public ushort Vk,Scan; public uint Flags,Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Explicit)] struct Union { [FieldOffset(0)] public Mouse Mouse; [FieldOffset(0)] public Key Key; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public Union U; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc,IntPtr param);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int length);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd,IntPtr dc,uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
  [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,Input[] inputs,int size);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj,int index,StringBuilder value,int length,out int needed);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder name,ref int length);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static string failureCode="INTERNAL_ERROR";
  static void Refuse(string code,string message){failureCode=code;throw new InvalidOperationException(message);}
  static Dictionary<string,object> Obj(object v){var d=v as Dictionary<string,object>;if(d==null)Refuse("INVALID_INPUT","expected object");return d;}
  static string Str(Dictionary<string,object> d,string k){object v;return d.TryGetValue(k,out v)&&v!=null?Convert.ToString(v):"";}
  static double Num(Dictionary<string,object> d,string k){object v;if(!d.TryGetValue(k,out v))Refuse("INVALID_INPUT","missing number");double n=Convert.ToDouble(v);if(double.IsNaN(n)||double.IsInfinity(n))Refuse("INVALID_INPUT","invalid number");return n;}
  static bool Flag(Dictionary<string,object> d,string k){object v;return d.TryGetValue(k,out v)&&v is bool&&(bool)v;}
  static bool Interactive(){
    if(!Environment.UserInteractive||Process.GetCurrentProcess().SessionId==0)return false;
    var desktop=OpenInputDesktop(0,false,1);if(desktop==IntPtr.Zero)return false;
    try{int needed;var name=new StringBuilder(128);return GetUserObjectInformation(desktop,2,name,256,out needed)&&name.ToString()=="Default";}
    finally{CloseDesktop(desktop);}
  }
  static string ImagePath(uint pid){
    var p=OpenProcess(0x1000,false,pid);if(p==IntPtr.Zero)return null;
    try{var text=new StringBuilder(32768);int length=text.Capacity;if(!QueryFullProcessImageName(p,0,text,ref length))return null;return Path.GetFullPath(text.ToString());}
    finally{CloseHandle(p);}
  }
  static string AppId(string image){using(var h=SHA256.Create()){var bytes=h.ComputeHash(Encoding.UTF8.GetBytes(image.ToUpperInvariant()));return "win."+BitConverter.ToString(bytes).Replace("-","").ToLowerInvariant().Substring(0,40);}}
  static HashSet<string> Allowed(Dictionary<string,object> request){
    object value;if(!request.TryGetValue("allowedApps",out value))Refuse("FORBIDDEN","owner app permission required");
    var array=value as object[];if(array==null||array.Length>20)Refuse("INVALID_INPUT","invalid allowed apps");
    var allowed=new HashSet<string>(StringComparer.Ordinal);foreach(var id in array)allowed.Add(Convert.ToString(id));return allowed;
  }
  static Dictionary<string,object> Window(IntPtr hwnd,HashSet<string> allowed,bool localList){
    if(!Interactive())Refuse("NOT_SUPPORTED","an unlocked interactive Windows desktop is required; Session 0 and secure desktops are refused");
    uint pid;GetWindowThreadProcessId(hwnd,out pid);if(pid==0||!IsWindowVisible(hwnd)||IsIconic(hwnd))return null;
    try{if(Process.GetProcessById((int)pid).SessionId!=Process.GetCurrentProcess().SessionId)return null;}catch{return null;}
    var image=ImagePath(pid);if(image==null)return null;string app=AppId(image);if(!localList&&!allowed.Contains(app))return null;
    Rect r;if(!GetWindowRect(hwnd,out r)||r.Right<=r.Left||r.Bottom<=r.Top||(long)(r.Right-r.Left)*(r.Bottom-r.Top)>40000000)return null;
    var title=new StringBuilder(301);GetWindowText(hwnd,title,title.Capacity);
    var item=new Dictionary<string,object>{{"windowId",hwnd.ToInt64()},{"pid",pid},{"appId",app},{"title",title.ToString()},{"bounds",new Dictionary<string,object>{{"x",r.Left},{"y",r.Top},{"width",r.Right-r.Left},{"height",r.Bottom-r.Top}}}};
    if(localList)item.Add("executable",image);return item;
  }
  static Dictionary<string,object> RequiredWindow(IntPtr hwnd,HashSet<string> allowed){var w=Window(hwnd,allowed,false);if(w==null)Refuse("FORBIDDEN","window is unavailable or not in the owner app allowlist");return w;}
  static void Fresh(Dictionary<string,object> request,Dictionary<string,object> target,HashSet<string> allowed,bool foreground){
    if(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()>Num(request,"deadline"))Refuse("STALE_WORKSPACE","capture a new snapshot; deadline expired");
    var hwnd=new IntPtr(Convert.ToInt64(Num(target,"windowId")));var now=RequiredWindow(hwnd,allowed);
    if(Str(now,"appId")!=Str(target,"appId")||Num(now,"pid")!=Num(target,"pid"))Refuse("STALE_WORKSPACE","window identity changed");
    var a=Obj(now["bounds"]);var b=Obj(target["bounds"]);foreach(var key in new[]{"x","y","width","height"})if(Num(a,key)!=Num(b,key))Refuse("STALE_WORKSPACE","window moved or resized; capture again");
    if(foreground&&GetForegroundWindow()!=hwnd)Refuse("CONFLICT","target window is not foreground; no input was sent");
  }
  static void Send(Input input){if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(Input)))!=1)Refuse("FORBIDDEN","Windows rejected input; no UAC/UIPI bypass was attempted");}
  static Input Keyboard(ushort vk,ushort scan,uint flags){return new Input{Type=1,U=new Union{Key=new Key{Vk=vk,Scan=scan,Flags=flags}}};}
  static Input Pointer(uint flags,int data){return new Input{Type=0,U=new Union{Mouse=new Mouse{Flags=flags,Data=unchecked((uint)data)}}};}
  static Point TargetPoint(Dictionary<string,object> target,double x,double y){
    double width=Num(target,"imageWidth"),height=Num(target,"imageHeight");if(x<0||y<0||x>=width||y>=height)Refuse("INVALID_INPUT","coordinates outside captured image");
    var b=Obj(target["bounds"]);return new Point((int)(Num(b,"x")+x*Num(b,"width")/width),(int)(Num(b,"y")+y*Num(b,"height")/height));
  }
  static void Position(Dictionary<string,object> request,Dictionary<string,object> target,HashSet<string> allowed,double x,double y){
    Fresh(request,target,allowed,true);var p=TargetPoint(target,x,y);var hwnd=new IntPtr(Convert.ToInt64(Num(target,"windowId")));
    if(GetAncestor(WindowFromPoint(p),2)!=hwnd)Refuse("CONFLICT","another window covers the target point; input refused");
    if(!SetCursorPos(p.X,p.Y))Refuse("FORBIDDEN","pointer movement refused");
  }
  static ushort VirtualKey(string key){
    if(key.Length==1&&char.IsLetterOrDigit(key[0]))return (ushort)char.ToUpperInvariant(key[0]);
    int f;if(key.StartsWith("f")&&int.TryParse(key.Substring(1),out f)&&f>=1&&f<=12)return (ushort)(0x70+f-1);
    var map=new Dictionary<string,ushort>{{"enter",13},{"tab",9},{"space",32},{"backspace",8},{"escape",27},{"delete",46},{"left",37},{"up",38},{"right",39},{"down",40},{"home",36},{"end",35},{"pageup",33},{"pagedown",34}};
    ushort v;if(!map.TryGetValue(key,out v))Refuse("INVALID_INPUT","unsupported key");return v;
  }
  static object Action(Dictionary<string,object> request,HashSet<string> allowed){
    var target=Obj(request["target"]);var action=Obj(request["action"]);var hwnd=new IntPtr(Convert.ToInt64(Num(target,"windowId")));string kind=Str(action,"kind");
    Fresh(request,target,allowed,false);
    if(kind=="focus"){
      if(GetForegroundWindow()!=hwnd&&!SetForegroundWindow(hwnd))Refuse("FORBIDDEN","Windows refused focus");Thread.Sleep(75);Fresh(request,target,allowed,true);
    }else{
      Fresh(request,target,allowed,true);
      if(kind=="type"){
        string text=Str(action,"text");if(text.Length==0||text.Length>2000)Refuse("INVALID_INPUT","invalid text length");
        foreach(char c in text){Fresh(request,target,allowed,true);try{Send(Keyboard(0,c,4));}finally{Send(Keyboard(0,c,6));}}
      }else if(kind=="key"){
        ushort key=VirtualKey(Str(action,"key"));var held=new List<ushort>();
        try{object m;if(action.TryGetValue("modifiers",out m)){foreach(var value in (object[])m){var name=Convert.ToString(value);ushort vk=name=="control"?(ushort)17:name=="shift"?(ushort)16:name=="option"?(ushort)18:name=="command"?(ushort)91:(ushort)0;if(vk==0)Refuse("INVALID_INPUT","invalid modifier");Send(Keyboard(vk,0,0));held.Add(vk);}}
          Fresh(request,target,allowed,true);Send(Keyboard(key,0,0));Send(Keyboard(key,0,2));
        }finally{held.Reverse();foreach(var vk in held)Send(Keyboard(vk,0,2));}
      }else{
        double x=Num(action,"x"),y=Num(action,"y");Position(request,target,allowed,x,y);
        if(kind=="click"){
          bool right=Str(action,"button")=="right";int count=action.ContainsKey("count")?(int)Num(action,"count"):1;if(count<1||count>2)Refuse("INVALID_INPUT","invalid click count");
          for(int i=0;i<count;i++){Fresh(request,target,allowed,true);try{Send(Pointer(right?8u:2u,0));}finally{Send(Pointer(right?16u:4u,0));}if(i+1<count)Thread.Sleep(75);}
        }else if(kind=="scroll"){
          int dy=(int)Num(action,"deltaY"),dx=action.ContainsKey("deltaX")?(int)Num(action,"deltaX"):0;if(Math.Abs(dy)>1000||Math.Abs(dx)>1000)Refuse("INVALID_INPUT","scroll too large");
          if(dy!=0)Send(Pointer(0x800,-dy));if(dx!=0)Send(Pointer(0x1000,dx));
        }else if(kind=="drag"){
          double tx=Num(action,"toX"),ty=Num(action,"toY");TargetPoint(target,tx,ty);
          try{Send(Pointer(2,0));for(int i=1;i<=10;i++){Position(request,target,allowed,x+(tx-x)*i/10,y+(ty-y)*i/10);Thread.Sleep(10);}}finally{Send(Pointer(4,0));}
        }else if(kind!="move")Refuse("INVALID_INPUT","unsupported action");
      }
    }
    return new{posted=true,note="Input posted to the owner-permitted window. Application effect must be checked in a new observation."};
  }
  static object Capture(Dictionary<string,object> request,HashSet<string> allowed){
    var hwnd=new IntPtr(Convert.ToInt64(Num(request,"windowId")));var window=RequiredWindow(hwnd,allowed);var bounds=Obj(window["bounds"]);
    int width=(int)Num(bounds,"width"),height=(int)Num(bounds,"height"),max=(int)Num(request,"maxEdge");if(max<1||max>2000)Refuse("INVALID_INPUT","invalid image bound");
    using(var raw=new Bitmap(width,height,PixelFormat.Format24bppRgb)){
      using(var g=Graphics.FromImage(raw)){g.Clear(Color.Black);var dc=g.GetHdc();bool ok;try{ok=PrintWindow(hwnd,dc,2);}finally{g.ReleaseHdc(dc);}if(!ok)Refuse("NOT_SUPPORTED","window capture failed (protected or unavailable surface)");}
      var again=RequiredWindow(hwnd,allowed);if(Json.Serialize(again)!=Json.Serialize(window))Refuse("STALE_WORKSPACE","window changed during capture");
      double scale=Math.Min(1.0,(double)max/Math.Max(width,height));int w=Math.Max(1,(int)(width*scale)),h=Math.Max(1,(int)(height*scale));
      using(var image=new Bitmap(raw,w,h))using(var stream=new MemoryStream()){
        image.Save(stream,ImageFormat.Jpeg);if(stream.Length>3*1024*1024)Refuse("RESOURCE_LIMIT","window image too large");
        window.Add("imageWidth",w);window.Add("imageHeight",h);window.Add("mimeType","image/jpeg");window.Add("image",Convert.ToBase64String(stream.ToArray()));
        // OCR is deliberately not fabricated; accessibility is a separate bounded operation.
        return window;
      }
    }
  }
  static object Accessibility(Dictionary<string,object> request,HashSet<string> allowed){
    var target=Obj(request["target"]);Fresh(request,target,allowed,false);var result=new List<object>();bool truncated=false;
    var root=AutomationElement.FromHandle(new IntPtr(Convert.ToInt64(Num(target,"windowId"))));var walker=TreeWalker.ControlViewWalker;
    var pending=new Queue<KeyValuePair<AutomationElement,int>>();pending.Enqueue(new KeyValuePair<AutomationElement,int>(root,0));
    while(pending.Count>0&&result.Count<100){
      Fresh(request,target,allowed,false);var item=pending.Dequeue();var element=item.Key;int depth=item.Value;
      try{var current=element.Current;bool redact=current.IsPassword||current.ControlType==ControlType.Edit;
        var row=new Dictionary<string,object>{{"role",current.ControlType.ProgrammaticName},{"depth",depth},{"redacted",redact}};
        if(!redact){string name=current.Name??"";row.Add("title",name.Substring(0,Math.Min(300,name.Length)));}result.Add(row);
        if(depth<6&&!redact){var child=walker.GetFirstChild(element);int count=0;while(child!=null&&count++<100&&pending.Count<100){pending.Enqueue(new KeyValuePair<AutomationElement,int>(child,depth+1));child=walker.GetNextSibling(child);}if(child!=null)truncated=true;}
      }catch(ElementNotAvailableException){truncated=true;}
    }
    return new{elements=result,truncated=truncated||pending.Count>0};
  }
  static object Run(Dictionary<string,object> request){
    string op=Str(request,"op");if(op=="status"||op=="requestPermissions"){bool ready=Interactive();return new{screenRecording=ready,accessibility=ready,platform="win32",backend="win32-printwindow-uia-sendinput"};}
    bool apps=op=="apps";var allowed=apps?new HashSet<string>():Allowed(request);
    if(op=="windows"||apps){var list=new List<object>();bool truncated=false;
      EnumWindows(delegate(IntPtr hwnd,IntPtr ignored){if(list.Count>=100){truncated=true;return false;}var w=Window(hwnd,allowed,apps);if(w!=null)list.Add(w);return true;},IntPtr.Zero);
      return new{windows=list,truncated=truncated};
    }
    if(op=="capture")return Capture(request,allowed);if(op=="action")return Action(request,allowed);if(op=="accessibility")return Accessibility(request,allowed);
    Refuse("INVALID_INPUT","unknown desktop operation");return null;
  }
  [STAThread] static int Main(){
    Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);SetProcessDPIAware();
    try{var text=new StringBuilder();var buffer=new char[2048];int n;while((n=Console.In.Read(buffer,0,buffer.Length))>0){text.Append(buffer,0,n);if(text.Length>65536)Refuse("RESOURCE_LIMIT","desktop request too large");}
      var data=Run(Obj(Json.DeserializeObject(text.ToString())));Console.Write(Json.Serialize(new{ok=true,data=data}));return 0;
    }catch(Exception e){string message=e is InvalidOperationException?e.Message:"Windows desktop operation failed; no privilege bypass was attempted";Console.Write(Json.Serialize(new{ok=false,error=new{code=failureCode,message=message}}));return 1;}
  }
}
