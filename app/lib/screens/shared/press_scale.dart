import 'package:flutter/widgets.dart';

import '../../theme/motion.dart';

/// Shrinks its child slightly while a finger is down on it, then springs
/// back — tactile feedback for tappable cards. Purely visual: it listens to
/// raw pointers, so the child's own tap handling is untouched.
class PressScale extends StatefulWidget {
  const PressScale({super.key, required this.child, this.scale = 0.96});

  final Widget child;
  final double scale;

  @override
  State<PressScale> createState() => _PressScaleState();
}

class _PressScaleState extends State<PressScale> {
  bool _down = false;

  void _set(bool down) {
    if (_down != down) setState(() => _down = down);
  }

  @override
  Widget build(BuildContext context) {
    return Listener(
      onPointerDown: (_) => _set(true),
      onPointerUp: (_) => _set(false),
      onPointerCancel: (_) => _set(false),
      child: AnimatedScale(
        scale: _down ? widget.scale : 1,
        duration: _down ? Motion.micro : Motion.medium,
        curve: _down ? Curves.easeOut : Curves.easeOutBack,
        child: widget.child,
      ),
    );
  }
}
